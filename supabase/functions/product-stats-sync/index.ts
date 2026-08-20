// 상품 stats(조회수·장바구니·찜·리뷰) 일별 적재 (Supabase Edge Function · pg_cron 일 1회)
//
// 범위(B): 최근 거래 상품만. 매일 = (어제 주문된 상품) ∪ (최근 95일 활동 추적셋) 의 "어제분" stats를
// products/stats로 당겨 mustit_api.product_stats_daily 에 upsert(0인 건 제외).
// 자격증명은 Vault(get_openapi_creds). service_role RPC(mustit_stats_tracked / mustit_upsert_product_stats)로 DB 접근.
// 수동/백필: { date: "YYYY-MM-DD" } 로 특정일 지정 가능.

const HOST = "https://api.mustit.co.kr";
const SB = Deno.env.get("SUPABASE_URL")!;
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" };

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

    const tok = await token();

    // 1) 그날 주문된 상품
    const ordered = new Set<string>();
    let page = 1;
    while (page <= 40) {
      const r = await apiGet(tok, "/open-api/order/v1/orders", { orderedFrom: day + " 00:00:00", orderedTo: day + " 23:59:59", pageNo: String(page), pageSize: "500" });
      if (!r.ok) break;
      const rd = (await r.json()).resultData || {};
      for (const it of (rd.items || [])) if (it.itemNo != null) ordered.add(String(it.itemNo));
      if (!rd.hasNext) break; page++;
    }

    // 2) 최근 95일 추적셋 (기존 적재 상품)
    const tr = await fetch(`${SB}/rest/v1/rpc/mustit_stats_tracked`, { method: "POST", headers: H, body: "{}" });
    const tracked: number[] = tr.ok ? await tr.json() : [];
    const all = Array.from(new Set<string>([...ordered, ...tracked.map(String)]));

    // 3) 그날 stats 조회 → 0 아닌 것만 rows
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500);
      const r = await apiGet(tok, "/open-api/item/v1/products/stats", { statsFrom: day, statsTo: day, itemNos: chunk.join(",") });
      if (!r.ok) continue;
      for (const it of ((await r.json()).resultData || [])) {
        const v = it.viewCount || 0, c = it.cartCount || 0, l = it.likeCount || 0, rv = it.reviewCount || 0;
        if (v + c + l + rv > 0) rows.push({ item_no: it.itemNo, d: day, view_count: v, cart_count: c, like_count: l, review_count: rv });
      }
    }

    // 4) upsert
    let upserted = 0;
    if (rows.length) {
      const up = await fetch(`${SB}/rest/v1/rpc/mustit_upsert_product_stats`, { method: "POST", headers: H, body: JSON.stringify({ rows }) });
      upserted = up.ok ? await up.json() : 0;
    }
    return new Response(JSON.stringify({ ok: true, date: day, orderedProducts: ordered.size, tracked: tracked.length, queried: all.length, storedRows: rows.length, upserted }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
