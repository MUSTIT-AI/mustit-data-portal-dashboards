// 대시보드 데이터 → AI 인사이트 (Supabase Edge Function)
//
// 브라우저(로그인 사용자)가 화면의 데이터(차트·표 JSON)를 넘기면, 서버가 OpenAI로
// 인사이트를 뽑아 텍스트로 돌려준다. OpenAI 키는 Supabase 시크릿에만 있고 브라우저엔 없음.
// verify_jwt=true → 로그인 사용자만 호출.
//
// 호출 (프론트): window.MUSTIT.fn("ai-insight", { data, context, question })
//   → { insight: "...", model: "gpt-4o-mini" }

// 시크릿 이름이 조금 달라도 잡히도록 흔한 후보를 순서대로 확인.
const OPENAI_KEY =
  Deno.env.get("OPENAI_API_KEY") ??
  Deno.env.get("OPENAI_KEY") ??
  Deno.env.get("OPENAI_SECRET_KEY") ??
  Deno.env.get("OPENAI") ??
  "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!OPENAI_KEY) {
      return json(500, { error: "OpenAI 키가 서버에 없습니다. Supabase Edge Function Secrets에 OPENAI_API_KEY 로 등록하세요." });
    }
    const body = await req.json().catch(() => ({}));

    // 진단용: {ping:true} 로 호출하면 키 존재만 확인(값 미노출)
    if (body.ping) return json(200, { ok: true, keyLoaded: true, model: MODEL });

    const data = body.data;
    const context = String(body.context ?? "머스트잇 대시보드 데이터");
    const question = String(body.question ?? "이 데이터의 핵심 인사이트 3~5개와 실행 제안을 뽑아줘.");
    const dataStr = (typeof data === "string" ? data : JSON.stringify(data ?? {})).slice(0, 120000);

    const sys =
      "당신은 머스트잇(명품 리셀 플랫폼)의 데이터 분석가입니다. 주어진 대시보드 데이터를 근거로 " +
      "한국어로 간결하고 실행 가능한 인사이트를 제공합니다. 반드시 숫자 근거를 함께 제시하고, " +
      "데이터에 없는 내용은 추측이라고 명시합니다. 불릿 위주로 답합니다.";
    const user = `맥락: ${context}\n\n데이터(JSON):\n${dataStr}\n\n요청: ${question}`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        temperature: 0.3,
      }),
    });
    const j = await r.json();
    if (!r.ok) return json(r.status, { error: j?.error?.message ?? `OpenAI HTTP ${r.status}` });
    return json(200, { insight: j?.choices?.[0]?.message?.content ?? "", model: MODEL });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) });
  }
});
