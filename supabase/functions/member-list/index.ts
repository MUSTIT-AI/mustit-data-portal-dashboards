// 회원 조회 프록시 (Supabase Edge Function)
//
// 머스트잇 Open API member/v1/members 엔드포인트를 서버측에서 인증 호출한다.
// 조회 방식 2가지:
//  ① 회원ID 지정(memberIds, 콤마 구분) → 날짜 범위 없이 단건씩 조회(API가 memberId 지정 시 예외 허용)
//  ② 가입일(joinedFrom/To) 또는 최근접속일(lastLoginFrom/To) 범위 — 최소 하나 필수, 각 축 최대 90일
// ②는 pageSize=1000 단위로 순차 페이지네이션해 MAX_PAGES까지 모아 한 번에 반환한다.
//
// 최근 30일 구매이력(withPurchases=true): order/v1/orders 를 최근 30일(오늘 포함) 조회해
// buyerId 별로 집계한 뒤 회원의 memberId 와 매칭해 붙인다. 주문 응답의 buyerId 는 회원의
// memberId 와 같은 값이라 이 축으로 조인된다(개인정보 컬럼/DB 권한 불필요 — Open API만 사용).
//   · gmv    = 전체 주문상태 합계(포털 공통지침: 거래액/GMV는 명시 없으면 취소를 제외하지 않음)
//   · netGmv = 취소·반품 상태(CANCEL_STATUSES) 제외 합계 = 실거래액
// 30일 창은 모든 요청이 동일하므로 웜 인스턴스에서 ORDERS_TTL_MS 동안 캐시해 재사용한다.
//
// 자격증명은 product-price / product-stats 와 동일하게 Vault(get_openapi_creds RPC)에서
// 읽는다 — Edge Function 시크릿을 별도로 등록할 필요가 없다(토큰 캐싱 포함, 2단계 인증).
//
// verify_jwt=true 로 배포 → 로그인한 사용자만 호출 가능.
// 호출 (프론트): window.MUSTIT.fn("member-list", { joinedFrom, joinedTo, lastLoginFrom, lastLoginTo, memberIds, withPurchases })
//   → { items: [{memberNo, memberId, gender, ageGroup, buyerGrade, joinedAt, lastLoginAt,
//               marketingConsent, smsConsent, emailConsent, kakaoConsent, pushConsent,
//               nightPushConsent, orderCount, gmv, netGmv}],
//       totalCount, truncated, purchaseWindow:{from,to} | null }

const BASE_URL = "https://api.mustit.co.kr";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PAGE_SIZE = 1000;
const MAX_PAGES = 10; // 상한 10,000행 — 기간이 넓으면 truncated:true로 알리고 프론트에서 기간을 좁히도록 안내
const MAX_MEMBER_IDS = 50; // 회원ID 직접 조회는 건당 1콜이라 상한을 둔다

const ORDER_PAGE_SIZE = 500;
const ORDER_MAX_PAGES = 60; // 최근 30일 ≈ 9천건(18페이지) 수준. 안전 상한.
const ORDER_FETCH_CONCURRENCY = 6;
const ORDERS_TTL_MS = 30 * 60 * 1000;

// 주문 응답 orderStatus 중 취소·반품 계열 — 실거래액(netGmv) 집계에서 제외한다.
const CANCEL_STATUSES = new Set([
  "BUYER_CANCEL_REQUESTED",
  "BUYER_CANCEL_APPROVED",
  "EXCHANGE_REQUESTED",
  "RETURN_REQUESTED",
  "RETURN_ACCEPTED",
  "RETURNED",
  "CANCEL_PENDING",
  "CANCELED",
  "BUYER_CANCELED",
]);

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let tokenInFlight: Promise<string> | null = null;

// Vault에 보관된 Open API 자격증명 조회 (service_role 전용 RPC)
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
      .then((t) => {
        cachedToken = t;
        return t.accessToken;
      })
      .finally(() => {
        tokenInFlight = null;
      });
  }
  return tokenInFlight;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface MemberOut {
  memberNo: number | null;
  memberId: string | null;
  gender: string | null;
  ageGroup: string | null;
  buyerGrade: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
  marketingConsent: string | null;
  smsConsent: string | null;
  emailConsent: string | null;
  kakaoConsent: string | null;
  pushConsent: string | null;
  nightPushConsent: string | null;
  orderCount: number | null;
  gmv: number | null;
  netGmv: number | null;
}

function mapMember(m: Record<string, unknown>): MemberOut {
  return {
    memberNo: (m.memberNo as number) ?? null,
    memberId: (m.memberId as string) ?? null,
    gender: (m.gender as string) ?? null,
    ageGroup: (m.ageGroup as string) ?? null,
    buyerGrade: (m.buyerGrade as string) ?? null,
    joinedAt: (m.joinedAt as string) ?? null,
    lastLoginAt: (m.lastLoginAt as string) ?? null,
    marketingConsent: (m.marketingConsent as string) ?? null,
    smsConsent: (m.smsConsent as string) ?? null,
    emailConsent: (m.emailConsent as string) ?? null,
    kakaoConsent: (m.kakaoConsent as string) ?? null,
    pushConsent: (m.pushConsent as string) ?? null,
    nightPushConsent: (m.nightPushConsent as string) ?? null,
    orderCount: null,
    gmv: null,
    netGmv: null,
  };
}

async function apiGet(token: string, path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${BASE_URL}${path}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok || body.resultCode >= 400) {
    throw new Error(body.resultMessage ?? `HTTP ${res.status}`);
  }
  return body.resultData ?? body;
}

// ── 최근 30일 구매 집계 (buyerId → {orderCount, gmv, netGmv}) ──
interface PurchaseAgg {
  orderCount: number;
  gmv: number;
  netGmv: number;
}
interface OrdersCache {
  key: string;
  map: Record<string, PurchaseAgg>;
  expiresAt: number;
}
let ordersCache: OrdersCache | null = null;
let ordersInFlight: Promise<Record<string, PurchaseAgg>> | null = null;

// KST(UTC+9) 기준 오늘 날짜 — Open API 일시는 KST 벽시계 값이므로 타임존 변환 없이 맞춘다.
function kstDate(offsetDays = 0): string {
  const t = Date.now() + 9 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

async function fetchOrderAgg(token: string, from: string, to: string): Promise<Record<string, PurchaseAgg>> {
  const key = `${from}_${to}`;
  if (ordersCache && ordersCache.key === key && ordersCache.expiresAt > Date.now()) return ordersCache.map;
  if (ordersInFlight) return ordersInFlight;

  ordersInFlight = (async () => {
    const map: Record<string, PurchaseAgg> = {};
    const base = { orderedFrom: `${from} 00:00:00`, orderedTo: `${to} 23:59:59`, pageSize: String(ORDER_PAGE_SIZE) };

    const absorb = (items: Record<string, unknown>[]) => {
      for (const o of items) {
        const buyer = String(o.buyerId ?? "");
        if (!buyer) continue;
        const gmv = Number(o.gmv) || 0;
        const cancelled = CANCEL_STATUSES.has(String(o.orderStatus ?? ""));
        const cur = map[buyer] ?? { orderCount: 0, gmv: 0, netGmv: 0 };
        cur.orderCount += 1;
        cur.gmv += gmv;
        if (!cancelled) cur.netGmv += gmv;
        map[buyer] = cur;
      }
    };

    // 1페이지로 총건수를 확인한 뒤, 남은 페이지는 병렬 배치로 가져온다(순차 20콜이면 너무 느림).
    const first = await apiGet(token, "/open-api/order/v1/orders", { ...base, pageNo: "1" });
    absorb(first.items ?? []);
    const total = Number(first.totalCount ?? 0);
    const lastPage = Math.min(ORDER_MAX_PAGES, Math.ceil(total / ORDER_PAGE_SIZE));

    for (let p = 2; p <= lastPage; p += ORDER_FETCH_CONCURRENCY) {
      const batch: Promise<Record<string, unknown>>[] = [];
      for (let i = p; i < p + ORDER_FETCH_CONCURRENCY && i <= lastPage; i++) {
        batch.push(apiGet(token, "/open-api/order/v1/orders", { ...base, pageNo: String(i) }));
      }
      const done = await Promise.all(batch);
      for (const d of done) absorb((d.items as Record<string, unknown>[]) ?? []);
    }

    ordersCache = { key, map, expiresAt: Date.now() + ORDERS_TTL_MS };
    return map;
  })().finally(() => {
    ordersInFlight = null;
  });

  return ordersInFlight;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    // Supabase 플랫폼이 verify_jwt=true 로 호출 인가(로그인 필수)를 강제한다.
    const payload = await req.json().catch(() => ({}));
    const joinedFrom = String(payload.joinedFrom ?? "").slice(0, 10);
    const joinedTo = String(payload.joinedTo ?? "").slice(0, 10);
    const lastLoginFrom = String(payload.lastLoginFrom ?? "").slice(0, 10);
    const lastLoginTo = String(payload.lastLoginTo ?? "").slice(0, 10);
    const withPurchases = payload.withPurchases !== false; // 기본 포함, 썸네일 등에서 false로 끌 수 있음
    const memberIds = String(payload.memberIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_MEMBER_IDS);

    const hasJoined = !!(joinedFrom && joinedTo);
    const hasLastLogin = !!(lastLoginFrom && lastLoginTo);
    if (!memberIds.length && !hasJoined && !hasLastLogin) {
      return new Response(
        JSON.stringify({ error: "회원ID를 입력하거나, 가입일·최근접속일 범위 중 최소 하나를 지정하세요." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const token = await getAccessToken();
    const items: MemberOut[] = [];
    let totalCount = 0;
    let truncated = false;

    if (memberIds.length) {
      // 회원ID 직접 조회 — API가 memberId 지정 시 날짜 범위를 요구하지 않는다(날짜 조건은 무시).
      const results = await Promise.all(
        memberIds.map((id) =>
          apiGet(token, "/open-api/member/v1/members", { memberId: id }).catch(() => ({ items: [] })),
        ),
      );
      for (const r of results) for (const m of r.items ?? []) items.push(mapMember(m));
      totalCount = items.length;
    } else {
      // Open API는 'yyyy-MM-dd HH:mm:ss' 형식을 요구한다(날짜만 넣으면 400) — 시작일 00:00:00·종료일 23:59:59로 하루 전체 포함.
      const base: Record<string, string> = { pageSize: String(PAGE_SIZE) };
      if (hasJoined) { base.joinedFrom = `${joinedFrom} 00:00:00`; base.joinedTo = `${joinedTo} 23:59:59`; }
      if (hasLastLogin) { base.lastLoginFrom = `${lastLoginFrom} 00:00:00`; base.lastLoginTo = `${lastLoginTo} 23:59:59`; }

      for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const data = await apiGet(token, "/open-api/member/v1/members", { ...base, pageNo: String(pageNo) });
        totalCount = Number(data.totalCount ?? totalCount);
        for (const m of data.items ?? []) items.push(mapMember(m));
        if (!data.hasNext) { truncated = false; break; }
        if (pageNo === MAX_PAGES) truncated = true;
      }
    }

    // 최근 30일(오늘 포함) 구매이력을 buyerId=memberId 축으로 붙인다.
    let purchaseWindow: { from: string; to: string } | null = null;
    if (withPurchases && items.length) {
      const from = kstDate(-29);
      const to = kstDate(0);
      purchaseWindow = { from, to };
      const agg = await fetchOrderAgg(token, from, to);
      for (const it of items) {
        const a = it.memberId ? agg[it.memberId] : undefined;
        if (a) { it.orderCount = a.orderCount; it.gmv = a.gmv; it.netGmv = a.netGmv; }
        else { it.orderCount = 0; it.gmv = 0; it.netGmv = 0; }
      }
    }

    return new Response(JSON.stringify({ items, totalCount, truncated, purchaseWindow }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
