// 상품 가격·재고 조회 프록시 (Supabase Edge Function)
//
// maxBenefitPrice(최대혜택가)·stock(재고)·marketLowestPrice(시장최저가)·
// mustitLowestPrice(M최저가)·discountedPrice(즉시할인가)는 머스트잇 Open API
// price-detail 엔드포인트의 실시간 값이라 매일 동기화되는 mustit_products/
// mustit_catalogs 뷰에는 없다(그건 selling_price까지만 보관, 재고는 있지만 하루
// 지연). 한 응답에 다 들어있어서 별도 호출 없이 함께 반환한다.
// (참고: C:\Users\Admin\Documents\Claude\ax_open_api\mustit-dashboard 의 더 발전된
// 버전과 필드명을 맞춤 — 그 앱은 GMV를 orders_v가 아니라 Open API 주문에서 직접
// 집계해서 별개 프로젝트이지만, 상품가격 필드 의미는 동일한 API라 그대로 재사용 가능)
// 이 함수가 서버측에서 인증하고 값만 로그인한 사용자에게 돌려준다.
//
// 자격증명은 openapi-orders / openapi-daily-sync 와 동일하게 Vault(get_openapi_creds RPC)에서
// 읽는다 — Edge Function 시크릿을 별도로 등록할 필요가 없다(토큰 캐싱 포함, 2단계 인증).
//
// verify_jwt=true 로 배포 → 로그인한 사용자만 호출 가능.
// 호출 (프론트): window.MUSTIT.fn("product-price", { itemNos: "123,456,789" })
//   → { "123": {maxBenefitPrice, stock, marketLowestPrice, mustitLowestPrice, discountedPrice},
//       "456": null, ... }  (null = 조회 실패/판매종료 등. 0은 "정보 없음"을 의미하는 값도 있음 — 최저가류)

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

    if (!ids.length) {
      return new Response(JSON.stringify({}), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const token = await getAccessToken();
    const url = `${BASE_URL}/open-api/item/v1/products/price-detail?itemNos=${encodeURIComponent(ids.join(","))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok || body.resultCode >= 400) {
      throw new Error(body.resultMessage ?? `HTTP ${res.status}`);
    }

    interface PriceOut {
      maxBenefitPrice: number | null;
      stock: number | null;
      marketLowestPrice: number | null;
      mustitLowestPrice: number | null;
      discountedPrice: number | null;
    }
    const out: Record<string, PriceOut | null> = {};
    for (const item of body.resultData ?? []) {
      out[String(item.itemNo)] = {
        maxBenefitPrice: item.maxBenefitPrice ?? null,
        stock: item.stock ?? null,
        marketLowestPrice: item.marketLowestPrice ?? null,
        mustitLowestPrice: item.mustitLowestPrice ?? null,
        discountedPrice: item.discountedPrice ?? null,
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
