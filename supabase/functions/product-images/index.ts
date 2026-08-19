// 상품 이미지 URL 조회 프록시 (Supabase Edge Function)
//
// 머스트잇 Open API(https://api.mustit.co.kr)는 client_secret + 비밀번호 2단계 인증이
// 필요한 진짜 비밀키를 써서, 정적 사이트 브라우저에 직접 넣을 수 없다. 이 함수가 서버측에서
// 대신 인증하고, 이미지 URL만(그 외 상세정보 제외) 로그인한 사용자에게 돌려준다.
// 인증 로직은 로컬 mustit-openapi-mcp/index.js 와 동일하다(토큰 캐싱 포함).
//
// 배포 전 시크릿 설정 (한 번만):
//   supabase secrets set --project-ref hhvmhtejmhhxksnldfmi \
//     MUSTIT_CLIENT_ID=xxx MUSTIT_CLIENT_SECRET=xxx OPENAPI_USERNAME=mustitapi OPENAPI_PASSWORD=xxx
// 배포:
//   supabase functions deploy product-images --project-ref hhvmhtejmhhxksnldfmi
//
// 호출 (프론트): window.MUSTIT.fn("product-images", { itemNos: "123,456,789" })
//   → { "123": "https://image.mustit.co.kr/...", "456": null, ... }

const BASE_URL = "https://api.mustit.co.kr";
const CLIENT_ID = Deno.env.get("MUSTIT_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("MUSTIT_CLIENT_SECRET") ?? "";
const USERNAME = Deno.env.get("OPENAPI_USERNAME") ?? "mustitapi";
const PASSWORD = Deno.env.get("OPENAPI_PASSWORD") ?? "";
const BASIC = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

const MAX_BULK_IDS = 500;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let tokenInFlight: Promise<string> | null = null;

async function postToken(authHeader: string, body: unknown) {
  const res = await fetch(`${BASE_URL}/auth/v1/token`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 (HTTP ${res.status}) — 시크릿(MUSTIT_CLIENT_ID/SECRET, OPENAPI_USERNAME/PASSWORD)을 확인하세요.`);
  return res.json();
}

async function issueToken(): Promise<CachedToken> {
  const guest = await postToken(`Basic ${BASIC}`, { grant_type: "client_credentials" });
  const final = await postToken(`Bearer ${guest.access_token}`, {
    grant_type: "password",
    username: USERNAME,
    password: PASSWORD,
  });
  // 만료 5분 전에 갱신되도록 여유를 둔다.
  return { accessToken: final.access_token, expiresAt: Date.now() + (final.expires_in - 300) * 1000 };
}

async function getAccessToken(): Promise<string> {
  if (!CLIENT_ID || !PASSWORD) {
    throw new Error("서버에 OPEN API 자격증명이 설정되어 있지 않습니다 (Supabase 시크릿 확인).");
  }
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
    // Supabase 플랫폼이 이 함수 호출 자체에 대해 Authorization JWT 검증을 이미 강제한다
    // (프로젝트 기본 설정 기준 로그인 필수) — 별도 인가 로직 없이 진행.
    const payload = await req.json().catch(() => ({}));
    const raw = String(payload.itemNos ?? "");
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_BULK_IDS);

    if (!ids.length) {
      return new Response(JSON.stringify({}), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const token = await getAccessToken();
    const url = `${BASE_URL}/open-api/item/v1/products/detail?itemNos=${encodeURIComponent(ids.join(","))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok || body.resultCode >= 400) {
      throw new Error(body.resultMessage ?? `HTTP ${res.status}`);
    }

    const out: Record<string, string | null> = {};
    for (const item of body.resultData ?? []) {
      out[String(item.itemNo)] = (item.images && item.images[0]) || null;
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
