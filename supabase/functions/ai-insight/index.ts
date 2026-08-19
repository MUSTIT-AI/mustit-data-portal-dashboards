// 대시보드 데이터 → AI 인사이트 (Supabase Edge Function)
//
// 브라우저(로그인 사용자)가 화면 데이터(JSON)를 넘기면 서버가 OpenAI로 인사이트를 뽑아 돌려준다.
// OpenAI 키는 Supabase 시크릿에만(브라우저 노출 없음). verify_jwt=true → 로그인 사용자만 호출.
//
// 호출: window.MUSTIT.fn("ai-insight", { data, context, question, model? })
//   { ping:true } → 키 로드 확인 / { listModels:true } → 사용가능 모델 목록
//
// 모델: 기본 gpt-5.5 (chat completions 지원 최고 플래그십). pro 계열은 chat 미지원이라 제외.

const OPENAI_KEY =
  Deno.env.get("OPENAI_API_KEY") ?? Deno.env.get("OPENAI_KEY") ??
  Deno.env.get("OPENAI_SECRET_KEY") ?? Deno.env.get("OPENAI") ?? "";
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.5";

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
    if (!OPENAI_KEY) return json(500, { error: "OpenAI 키가 서버에 없습니다. Supabase Edge Function Secrets에 OPENAI_API_KEY 로 등록하세요." });
    const body: any = await req.json().catch(() => ({}));

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
    if (/^(gpt-4|gpt-3)/.test(useModel)) payload.temperature = 0.3; // 구모델만 temperature 지정(GPT-5·o계열은 기본값)

    const t0 = Date.now();
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) return json(r.status, { error: j?.error?.message ?? `OpenAI HTTP ${r.status}`, model: useModel });
    return json(200, { insight: j?.choices?.[0]?.message?.content ?? "", model: useModel, ms: Date.now() - t0 });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) });
  }
});
