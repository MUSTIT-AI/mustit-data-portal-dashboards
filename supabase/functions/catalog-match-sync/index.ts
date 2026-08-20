// 카탈로그 매칭 스냅샷 적재 (Supabase Edge Function · pg_cron 일 1회)
//
// 하는 일: 지정일에 신규 등록된 상품의 catalogId를 모아 catalogs/stats로 matchedItemCount를
// 조회해 mustit_api.catalog_match_snapshot 에 upsert. 대시보드(d-mszs5qkscg4)의
// catalog_matching_report RPC가 이 테이블을 참조해 매칭/미매칭을 판정한다.
//
// 왜 필요한가: mustit_api.products 안에서 catalog_id를 group by 해 세면 미러에 없는
// 형제 상품이 빠져 "거짓 미매칭"이 된다. 2026-08-19 실측 대조에서 로컬 집계 29.58% vs
// API 55.16% (매칭 건수 86% 과소집계). matchedItemCount 는 전체 카탈로그 기준 실시간 값.
//
// 자격증명은 Vault(get_openapi_creds). DB 쓰기는 service_role RPC(mustit_upsert_catalog_match).
// 수동/백필: { date: "YYYY-MM-DD" } 또는 { from: "...", to: "..." } 로 지정 가능.
//
// 주의
//  · products API 는 productStats 미지정 시 IN_STOCK 만 반환한다 → 3개 상태를 각각 순회.
//    (2026-08-19 실측: IN_STOCK 27,383 / OUT_OF_STOCK 791 / SUSPENDED 18 — 미지정 시 2.9% 누락)
//  · catalogs/stats 는 catalogIds 500건 배치에서 p95 7.2초 / max 10.23초로 10초 타임아웃
//    (QA-3661) 경계에 닿고 실제로 502가 났다 → 기본 배치 250.
//  · Edge Function 벽시계 제한이 있으므로 하루치 단위로 호출할 것. 장기 백필은
//    날짜별로 여러 번 호출한다(1일 ≈ 160콜 / 40초 내외).

const HOST = "https://api.mustit.co.kr";
const SB = Deno.env.get("SUPABASE_URL")!;
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" };

const STATUSES = ["IN_STOCK", "OUT_OF_STOCK", "SUSPENDED"];
const PAGE_SIZE = 500;
const MAX_PAGES = 400; // 폭주 방지 (1일 최대 20만건 상정)

async function creds() {
  const r = await fetch(`${SB}/rest/v1/rpc/get_openapi_creds`, { method: "POST", headers: H, body: "{}" });
  if (!r.ok) throw new Error("creds " + r.status);
  return await r.json();
}
async function token(): Promise<string> {
  const c = await creds();
  const basic = String(c.basic).includes(":") ? btoa(c.basic) : c.basic;
  const g = await (await fetch(`${HOST}/auth/v1/token`, { method: "POST", headers: { Authorization: "Basic " + basic, "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials" }) })).json();
  const f = await (await fetch(`${HOST}/auth/v1/token`, { method: "POST", headers: { Authorization: "Bearer " + g.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "password", username: c.username, password: c.password }) })).json();
  return f.access_token as string;
}
async function apiGet(tok: string, path: string, qs: Record<string, string>) {
  const url = `${HOST}${path}?` + new URLSearchParams(qs);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + tok } });
    if (r.status !== 429 && r.status < 500) return r;
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
  return await fetch(url, { headers: { Authorization: "Bearer " + tok } });
}
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const nowKst = new Date(Date.now() + 9 * 3600000);
    const day = String(body.date || ymd(new Date(nowKst.getTime() - 86400000))); // 기본 = 어제(KST)
    const from = String(body.from || day + " 00:00:00");
    const to = String(body.to || day + " 23:59:59");
    const batch = Math.max(50, Math.min(Number(body.batch) || 250, 500));

    const tok = await token();

    // 1) 기간 내 신규 등록 상품 → catalogId 수집 (판매상태 3종 각각 순회)
    const catalogIds = new Set<string>();
    let items = 0, noCatalog = 0, pagesFetched = 0;
    const perStatus: Record<string, number> = {};

    for (const st of STATUSES) {
      let page = 1, got = 0;
      while (page <= MAX_PAGES) {
        const r = await apiGet(tok, "/open-api/item/v1/products", {
          queryType: "CREATED", createdFrom: from, createdTo: to,
          productStats: st, pageNo: String(page), pageSize: String(PAGE_SIZE),
        });
        pagesFetched++;
        if (!r.ok) break;
        const rd = (await r.json()).resultData || {};
        for (const it of (rd.items || [])) {
          items++; got++;
          if (it.catalogId == null) noCatalog++; // 당일 신규는 카탈로그 미배정 상태일 수 있다
          else catalogIds.add(String(it.catalogId));
        }
        if (!rd.hasNext) break;
        page++;
      }
      perStatus[st] = got;
    }

    // 2) distinct catalogId → matchedItemCount 조회
    const all = Array.from(catalogIds);
    const rows: Record<string, unknown>[] = [];
    let statsCalls = 0, statsFailed = 0;
    for (let i = 0; i < all.length; i += batch) {
      const chunk = all.slice(i, i + batch);
      const r = await apiGet(tok, "/open-api/item/v1/catalogs/stats", { catalogIds: chunk.join(",") });
      statsCalls++;
      if (!r.ok) { statsFailed++; continue; }
      for (const it of ((await r.json()).resultData || [])) {
        if (it.catalogId == null || it.matchedItemCount == null) continue;
        rows.push({
          catalog_id: it.catalogId,
          matched_item_count: it.matchedItemCount,
          selling_item_count: it.sellingItemCount ?? null,
        });
      }
    }

    // 3) upsert (RPC 페이로드가 과대해지지 않게 5,000건씩 나눠 전송)
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 5000) {
      const up = await fetch(`${SB}/rest/v1/rpc/mustit_upsert_catalog_match`, {
        method: "POST", headers: H, body: JSON.stringify({ rows: rows.slice(i, i + 5000) }),
      });
      if (up.ok) upserted += Number(await up.json()) || 0;
    }

    const matched = rows.filter((r) => Number(r.matched_item_count) > 1).length;
    return new Response(JSON.stringify({
      ok: true, date: day, from, to, batch,
      items, perStatus, itemsWithoutCatalog: noCatalog,
      distinctCatalogs: all.length,
      productPages: pagesFetched, statsCalls, statsFailed,
      snapshotRows: rows.length, upserted,
      catalogsMatched: matched,
      catalogsUnmatched: rows.length - matched,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
