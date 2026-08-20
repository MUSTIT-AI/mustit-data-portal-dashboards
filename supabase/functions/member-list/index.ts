// 회원 조회 프록시 (Supabase Edge Function)
//
// 머스트잇 Open API member/v1/members 엔드포인트를 서버측에서 인증 호출한다.
// 가입일(joinedFrom/To) 또는 최근접속일(lastLoginFrom/To) 범위 중 최소 하나 필수(API 제약,
// 각 축 최대 90일). 날짜 범위 안의 전체 회원을 pageSize=1000 단위로 순차 페이지네이션해
// MAX_PAGES까지 모아 한 번에 반환한다(브라우저는 필터 적용 후 여러 페이지를 개별 호출할
// 필요 없이 한 번만 호출).
//
// 자격증명은 product-price / product-stats 와 동일하게 Vault(get_openapi_creds RPC)에서
// 읽는다 — Edge Function 시크릿을 별도로 등록할 필요가 없다(토큰 캐싱 포함, 2단계 인증).
//
// verify_jwt=true 로 배포 → 로그인한 사용자만 호출 가능.
// 호출 (프론트): window.MUSTIT.fn("member-list", { joinedFrom, joinedTo, lastLoginFrom, lastLoginTo })
//   → { items: [{memberNo, memberId, gender, ageGroup, buyerGrade, joinedAt, lastLoginAt,
//               marketingConsent, smsConsent, emailConsent, kakaoConsent, pushConsent,
//               nightPushConsent}], totalCount, truncated }

const BASE_URL = "https://api.mustit.co.kr";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PAGE_SIZE = 1000;
const MAX_PAGES = 10; // 상한 10,000행 — 기간이 넓으면 truncated:true로 알리고 프론트에서 기간을 좁히도록 안내

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

    const hasJoined = !!(joinedFrom && joinedTo);
    const hasLastLogin = !!(lastLoginFrom && lastLoginTo);
    if (!hasJoined && !hasLastLogin) {
      return new Response(JSON.stringify({ error: "가입일 또는 최근접속일 범위 중 최소 하나는 필수입니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const token = await getAccessToken();
    // Open API는 'yyyy-MM-dd HH:mm:ss' 형식을 요구한다(날짜만 넣으면 400) — 시작일 00:00:00·종료일 23:59:59로 하루 전체 포함.
    const qs = new URLSearchParams();
    if (hasJoined) { qs.set("joinedFrom", `${joinedFrom} 00:00:00`); qs.set("joinedTo", `${joinedTo} 23:59:59`); }
    if (hasLastLogin) { qs.set("lastLoginFrom", `${lastLoginFrom} 00:00:00`); qs.set("lastLoginTo", `${lastLoginTo} 23:59:59`); }
    qs.set("pageSize", String(PAGE_SIZE));

    const items: MemberOut[] = [];
    let totalCount = 0;
    let truncated = false;

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      qs.set("pageNo", String(pageNo));
      const res = await fetch(`${BASE_URL}/open-api/member/v1/members?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok || body.resultCode >= 400) {
        throw new Error(body.resultMessage ?? `HTTP ${res.status}`);
      }
      const data = body.resultData ?? body; // 도구 스키마: items/totalCount/pageNo/pageSize/hasNext
      totalCount = Number(data.totalCount ?? totalCount);
      for (const m of data.items ?? []) {
        items.push({
          memberNo: m.memberNo ?? null,
          memberId: m.memberId ?? null,
          gender: m.gender ?? null,
          ageGroup: m.ageGroup ?? null,
          buyerGrade: m.buyerGrade ?? null,
          joinedAt: m.joinedAt ?? null,
          lastLoginAt: m.lastLoginAt ?? null,
          marketingConsent: m.marketingConsent ?? null,
          smsConsent: m.smsConsent ?? null,
          emailConsent: m.emailConsent ?? null,
          kakaoConsent: m.kakaoConsent ?? null,
          pushConsent: m.pushConsent ?? null,
          nightPushConsent: m.nightPushConsent ?? null,
        });
      }
      if (!data.hasNext) { truncated = false; break; }
      if (pageNo === MAX_PAGES) truncated = true;
    }

    return new Response(JSON.stringify({ items, totalCount, truncated }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
