// 카탈로그 매칭 현황 동기화 (Supabase Edge Function)
//
// 머스트잇 OPEN API에서 "신규 등록 상품"과 그 상품이 속한 카탈로그의 실제 매칭 상품 수
// (/open-api/item/v1/catalogs/matched-items 의 matchedItemCount, athena_item.CATALOG_ITEM_V2
// 실시간 집계)를 가져와 주간/판매자별로 집계한 뒤 public.catalog_matching_weekly /
// public.catalog_matching_by_seller 테이블에 적재한다.
//
// 매칭 정의: item.catalogId가 있고 그 카탈로그의 matchedItemCount > 1 이면 매칭,
//           catalogId가 없거나 matchedItemCount <= 1 이면 미매칭.
// (수기 주간 리포트의 "매칭 상품 수>1=매칭" 로직과 동일 — 다만 여기서는 근사치가 아니라
//  Open API가 실시간으로 계산해주는 값을 그대로 씀)
//
// 자격증명은 product-price/openapi-daily-sync와 동일하게 Vault(get_openapi_creds RPC)에서 읽는다.
// pg_cron으로 하루 1회(예: 08:10 KST, openapi-daily-sync 직후) 호출하는 것을 전제로 작성함.
// 호출 (수동 1회 실행 또는 cron): POST body { "days": 91 } — 오늘로부터 며칠치를 동기화할지
// (90일 초과 시 90일 단위로 나눠 여러 번 호출 — Open API 자체가 CREATED 조회를 90일로 제한하기 때문).
//
// 전사 공용 API 호출 한도(초당 50/분당 3,000)를 쓰는 배치 작업입니다 — 반복 실행 전
// OPEN API 담당자에게 공유했는지 확인하세요 (임직원 가이드 10장).

const BASE_URL = "https://api.mustit.co.kr";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DAY_MS = 86400000;
const MAX_WINDOW_DAYS = 90; // Open API CREATED 조회 제약
const CATALOG_BATCH = 500;  // matched-items 1회 최대 500건
const PRODUCT_PAGE_SIZE = 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;
let tokenInFlight: Promise<string> | null = null;

async function creds(): Promise<{ basic: string; username: string; password: string }> {
  const r = await fetch(`${SB}/rest/v1/rpc/get_openapi_creds`, {
    method: "POST",
    headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`자격증명 조회 실패 (get_openapi_creds HTTP ${r.status})`);
  return await r.json();
}

async function postToken(authHeader: string, body: unknown) {
  const res = await fetch(`${BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 (HTTP ${res.status})`);
  return res.json();
}

async function issueToken(): Promise<CachedToken> {
  const c = await creds();
  const basicHeader = String(c.basic).includes(":") ? btoa(c.basic) : c.basic;
  const guest = await postToken(`Basic ${basicHeader}`, { grant_type: "client_credentials" });
  const final = await postToken(`Bearer ${guest.access_token}`, {
    grant_type: "password",
    username: c.username,
    password: c.password,
  });
  return { accessToken: final.access_token, expiresAt: Date.now() + (final.expires_in - 300) * 1000 };
}

async function getAccessToken(): Promise<string> {
  if (!SB || !SK) throw new Error("서버 환경(SUPABASE_URL/SERVICE_ROLE_KEY) 미설정");
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  if (!tokenInFlight) {
    tokenInFlight = issueToken()
      .then((t) => { cachedToken = t; return t.accessToken; })
      .finally(() => { tokenInFlight = null; });
  }
  return tokenInFlight;
}

async function apiGet(token: string, path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok || body.resultCode >= 400) throw new Error(body.resultMessage ?? `HTTP ${res.status}`);
  return body.resultData;
}

function fmtKst(d: Date, endOfDay = false): string {
  // 날짜만 KST 기준으로 다룬다는 전제(서버 실행 위치 무관하게 UTC 계산 후 표기만 KST 포맷).
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(day)} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

interface RawItem { itemNo: number; catalogId: number | null; sellerId: string; createdAt: string }

async function fetchProductsWindow(token: string, from: Date, to: Date): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let pageNo = 1;
  for (;;) {
    const qs = new URLSearchParams({
      queryType: "CREATED",
      createdFrom: fmtKst(from),
      createdTo: fmtKst(to, true),
      productStats: "IN_STOCK,OUT_OF_STOCK,SUSPENDED", // 전체 신규 등록(현재 판매상태 무관)
      pageNo: String(pageNo),
      pageSize: String(PRODUCT_PAGE_SIZE),
    });
    const data = await apiGet(token, `/open-api/item/v1/products?${qs.toString()}`);
    for (const it of data.items ?? []) {
      items.push({
        itemNo: it.itemNo,
        catalogId: it.catalogId ?? null,
        sellerId: it.sellerId,
        createdAt: it.createdAt,
      });
    }
    if (!data.hasNext) break;
    pageNo++;
    if (pageNo > 500) break; // 안전장치(최대 50만 건/구간)
  }
  return items;
}

async function fetchMatchedCounts(token: string, catalogIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < catalogIds.length; i += CATALOG_BATCH) {
    const chunk = catalogIds.slice(i, i + CATALOG_BATCH);
    const data = await apiGet(token, `/open-api/item/v1/catalogs/matched-items?catalogIds=${chunk.join(",")}`);
    for (const row of data ?? []) out.set(Number(row.catalogId), Number(row.matchedItemCount) || 0);
  }
  return out;
}

function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

async function upsert(table: string, rows: unknown[]) {
  if (!rows.length) return;
  const res = await fetch(`${SB}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SK,
      Authorization: `Bearer ${SK}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert 실패 (HTTP ${res.status}): ${await res.text()}`);
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const payload = await req.json().catch(() => ({}));
    const days = Math.max(1, Math.min(Number(payload.days) || 91, 371)); // 최대 약 53주
    const token = await getAccessToken();

    const now = new Date();
    const start = new Date(now.getTime() - days * DAY_MS);

    // 90일 제약 때문에 구간을 나눠 순차 호출
    const all: RawItem[] = [];
    let cursor = new Date(start);
    while (cursor < now) {
      const winEnd = new Date(Math.min(cursor.getTime() + MAX_WINDOW_DAYS * DAY_MS, now.getTime()));
      const chunkItems = await fetchProductsWindow(token, cursor, winEnd);
      all.push(...chunkItems);
      cursor = new Date(winEnd.getTime() + DAY_MS);
    }

    const uniqueCatalogIds = Array.from(new Set(all.map((it) => it.catalogId).filter((c): c is number => c != null)));
    const matchedCounts = await fetchMatchedCounts(token, uniqueCatalogIds);

    function isMatched(it: RawItem): boolean {
      if (it.catalogId == null) return false;
      return (matchedCounts.get(it.catalogId) ?? 0) > 1;
    }

    // 주간 집계
    const weekly = new Map<string, { new_items: number; matched: number; unmatched: number }>();
    for (const it of all) {
      const wk = mondayOf(new Date(it.createdAt.replace(" ", "T") + "+09:00"));
      const row = weekly.get(wk) ?? { new_items: 0, matched: 0, unmatched: 0 };
      row.new_items++;
      if (isMatched(it)) row.matched++; else row.unmatched++;
      weekly.set(wk, row);
    }
    const weeklyRows = Array.from(weekly.entries()).map(([week_start, v]) => {
      const we = new Date(week_start + "T00:00:00Z"); we.setUTCDate(we.getUTCDate() + 6);
      return { week_start, week_end: we.toISOString().slice(0, 10), ...v, synced_at: new Date().toISOString() };
    });

    // 판매자별 집계 (동기화 대상 전체 기간 기준)
    const bySeller = new Map<string, { new_items: number; matched: number; unmatched: number }>();
    for (const it of all) {
      const row = bySeller.get(it.sellerId) ?? { new_items: 0, matched: 0, unmatched: 0 };
      row.new_items++;
      if (isMatched(it)) row.matched++; else row.unmatched++;
      bySeller.set(it.sellerId, row);
    }
    const sellerRows = Array.from(bySeller.entries()).map(([seller_id, v]) => ({
      seller_id,
      ...v,
      match_rate: v.new_items ? Math.round((v.matched / v.new_items) * 10000) / 10000 : null,
      window_days: days,
      synced_at: new Date().toISOString(),
    }));

    await upsert("catalog_matching_weekly", weeklyRows);
    // 판매자 테이블은 매번 전체 교체(오래된 판매자가 안 남도록) — service_role 로 delete 후 insert
    await fetch(`${SB}/rest/v1/catalog_matching_by_seller?window_days=eq.${days}`, {
      method: "DELETE",
      headers: { apikey: SK, Authorization: `Bearer ${SK}` },
    });
    await upsert("catalog_matching_by_seller", sellerRows);

    return new Response(JSON.stringify({
      ok: true, days, itemsFetched: all.length, uniqueCatalogIds: uniqueCatalogIds.length,
      weeks: weeklyRows.length, sellers: sellerRows.length,
    }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
