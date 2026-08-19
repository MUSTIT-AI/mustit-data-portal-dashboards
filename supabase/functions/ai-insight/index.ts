// 대시보드 데이터 → AI 인사이트 (Supabase Edge Function) + 이력 저장/조회
//
// 브라우저(로그인 사용자)가 화면 데이터를 넘기면 서버가 OpenAI로 인사이트를 뽑아 돌려주고,
// public.ai_insights 테이블에 이력으로 저장한다. OpenAI 키는 Supabase 시크릿에만.
// verify_jwt=true → 로그인 사용자만 호출.
//
// 호출:
//   생성: window.MUSTIT.fn("ai-insight", { data, context, question, dashboard, params, model? })
//   이력: window.MUSTIT.fn("ai-insight", { history:true, dashboard?, limit? })
//   진단: { ping:true } / { listModels:true }

const OPENAI_KEY =
  Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ??
  Deno.env.get("OPENAI_SECRET_KEY") ?? Deno.env.get("OPENAI") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.5";
const SB = Deno.env.get("SUPABASE_URL") ?? "";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const DBH = { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json" };

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// 요청 JWT에서 작성자 이메일 추출(verify_jwt=true라 유효한 토큰)
async function userEmail(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || !SB) return null;
  try {
    const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SK, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u?.email ? String(u.email).toLowerCase() : null);
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body: any = await req.json().catch(() => ({}));

    // 이력 조회 (id 지정 시 단건 = 공유 URL용)
    if (body.history) {
      const idq = body.id ? `&id=eq.${Number(body.id)}` : "";
      const dash = body.dashboard ? `&dashboard=eq.${encodeURIComponent(String(body.dashboard))}` : "";
      const lim = Math.min(Number(body.limit) || 20, 200);
      const r = await fetch(`${SB}/rest/v1/ai_insights?select=id,created_at,author,dashboard,params,question,insight,model&order=created_at.desc&limit=${lim}${dash}${idq}`, { headers: DBH });
      return json(200, { history: r.ok ? await r.json() : [] });
    }

    if (!OPENAI_KEY) return json(500, { error: "OpenAI 키가 서버에 없습니다 (Supabase Secrets OPENAI_API_KEY)." });
    if (body.ping) return json(200, { ok: true, keyLoaded: true, model: MODEL });
    if (body.listModels) {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${OPENAI_KEY}` } });
      const j = await r.json();
      const ids = (j?.data ?? []).map((m: any) => m.id).filter((id: string) => /^(gpt|o[0-9]|chatgpt)/.test(id)).sort();
      return json(200, { models: ids });
    }

    const useModel = String(body.model || MODEL);
    const data = body.data;
    const context = String(body.context ?? "머스트잇 대시보드 데이터");
    const question = String(body.question ?? "이 데이터의 핵심 인사이트 3~5개와 실행 제안을 뽑아줘.");
    const dataStr = (typeof data === "string" ? data : JSON.stringify(data ?? {})).slice(0, 120000);

    const sys =
      "당신은 머스트잇(명품 리셀 플랫폼)의 데이터 분석가입니다. 주어진 대시보드 데이터를 근거로 " +
      "한국어로 간결하고 실행 가능한 인사이트를 제공합니다. 반드시 숫자 근거를 함께 제시하고, " +
      "데이터에 없는 내용은 추측이라고 명시합니다. 불릿 위주로 답합니다.";
    const user = `맥락: ${context}\n\n데이터(JSON):\n${dataStr}\n\n요청: ${question}`;

    const payload: any = { model: useModel, messages: [{ role: "system", content: sys }, { role: "user", content: user }] };
    if (/^(gpt-4|gpt-3)/.test(useModel)) payload.temperature = 0.3;

    const t0 = Date.now();
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok) return json(r.status, { error: j?.error?.message ?? `OpenAI HTTP ${r.status}`, model: useModel });
    const insight = j?.choices?.[0]?.message?.content ?? "";

    // 이력 저장 (실패해도 결과 반환은 유지) · 저장 성공 시 id 반환(공유 URL용)
    let saved = false; let insightId: number | null = null;
    try {
      const author = await userEmail(req);
      const sr = await fetch(`${SB}/rest/v1/ai_insights`, {
        method: "POST", headers: { ...DBH, Prefer: "return=representation" },
        body: JSON.stringify({ author, dashboard: body.dashboard ?? null, params: body.params ?? null, question, insight, model: useModel }),
      });
      if (sr.ok) { const row = await sr.json(); insightId = Array.isArray(row) && row[0] ? row[0].id : null; saved = true; }
    } catch { /* 저장 실패 무시 */ }

    return json(200, { insight, model: useModel, ms: Date.now() - t0, saved, id: insightId });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) });
  }
});
