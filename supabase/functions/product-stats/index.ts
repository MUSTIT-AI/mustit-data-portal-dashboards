// 상품 조회수·장바구니·찜 조회 프록시 (Supabase Edge Function)
//
// viewCount(조회수)·cartCount(장바구니)·likeCount(찜)는 머스트잇 Open API
// products/stats 엔드포인트의 기간 집계값이다. 원천 테이블이 95일치만 보관하므로
// statsFrom은 조회일 기준 95일 이내여야 한다(그 밖은 API가 에러를 반환) — 프론트에서
// 조회 기간이 조건을 벗어나면 아예 호출하지 않고 "-"로 표시한다.
//
// 자격증명은 product-images / product-price 와 동일하게 Vault(get_openapi_creds RPC)에서
// 읽는다 — Edge Function 시크릿을 별도로 등록할 필요가 없다(토큰 캐싱 포함, 2단계 인증).
//
// verify_jwt=true 로 배포 → 로그인한 사용자만 호출 가능.
// 호출 (프론트): window.MUSTIT.fn("product-stats", { itemNos: "123,456", statsFrom: "2026-05-17", statsTo: "2026-08-19" })
//   → { "123": {viewCount, cartCount, likeCount}, "456": null, ... }  (null = 조회 실패 등)

const BASE_URL = "https://api.mustit.co.kr";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_BULK_IDS = 500;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    // Supabase 플랫폼이 verify_jwt=true 로 호출 인가(로그인 필수)를 강제한다.
    const payload = await req.json().catch(() => ({}));
    const raw = String(payload.itemNos ?? "");
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_BULK_IDS);
    const statsFrom = String(payload.statsFrom ?? "").slice(0, 10);
    const statsTo = String(payload.statsTo ?? "").slice(0, 10);

    if (!ids.length || !statsFrom || !statsTo) {
      return new Response(JSON.stringify({}), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const token = await getAccessToken();
    const url =
      `${BASE_URL}/open-api/item/v1/products/stats?statsFrom=${encodeURIComponent(statsFrom)}` +
      `&statsTo=${encodeURIComponent(statsTo)}&itemNos=${encodeURIComponent(ids.join(","))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok || body.resultCode >= 400) {
      throw new Error(body.resultMessage ?? `HTTP ${res.status}`);
    }

    interface StatsOut {
      viewCount: number | null;
      cartCount: number | null;
      likeCount: number | null;
    }
    const out: Record<string, StatsOut | null> = {};
    for (const item of body.resultData ?? []) {
      out[String(item.itemNo)] = {
        viewCount: item.viewCount ?? null,
        cartCount: item.cartCount ?? null,
        likeCount: item.likeCount ?? null,
      };
    }
    return new Response(JSON.stringify(out), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
