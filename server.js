// MUST IT 대시보드 서버 — 비밀번호 게이트 + 대시보드 파일 서빙 + 읽기전용 데이터 API
// 데이터: Supabase RPC public.dash_query (anon 권한, SELECT만, orders_v/orders_v_kr만)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const PW = process.env.DASH_PASSWORD || "";
const DIR = __dirname;
const DASHDIR = path.join(DIR, "dashboards");
const H = { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" };

const token = () => crypto.createHash("sha256").update("dash|" + PW).digest("hex");
function cookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function authed(req) { return !!PW && cookies(req).dash_auth === token(); }
function body(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); }); }
function send(res, s, ct, b, extra) { res.writeHead(s, Object.assign({ "Content-Type": ct, "Cache-Control": "no-store" }, extra || {})); res.end(b); }
const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const LOGIN = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>MUST IT 대시보드 로그인</title><body style="font-family:'Pretendard',system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f4f5"><form onsubmit="go(event)" style="background:#fff;padding:32px;border-radius:14px;box-shadow:0 2px 14px rgba(0,0,0,.08);width:300px"><h2 style="margin:0 0 14px">📊 MUST IT 대시보드</h2><input id=p type=password placeholder="접속 비밀번호" autofocus style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box"><button style="width:100%;margin-top:10px;padding:11px;border:0;border-radius:8px;background:#c8102e;color:#fff;font-weight:700;font-size:15px;cursor:pointer">들어가기</button><p id=m style="color:#c8102e;font-size:13px;min-height:16px;margin:8px 0 0"></p></form><script>async function go(ev){ev.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});if(r.ok)location.reload();else document.getElementById('m').textContent='비밀번호가 틀립니다.';}</script>`;

const DASHJS = `// 대시보드 데이터 헬퍼: dashQuery("select ...") → 행 배열(Promise)
window.dashQuery=async function(sql){const r=await fetch('/api/q',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql:sql})});const d=await r.json();if(!r.ok||(d&&d.code))throw new Error((d&&d.message)||('query error '+r.status));return d;};`;

function indexPage() {
  let items = [];
  try { items = fs.readdirSync(DASHDIR).filter((f) => f.endsWith(".html")); } catch (e) {}
  const cards = items.map((f) => { const n = f.replace(/\.html$/, ""); return `<a class=card href="/d/${encodeURIComponent(n)}">📊 ${esc(n)}</a>`; }).join("");
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>MUST IT 대시보드</title><style>body{font-family:'Pretendard',system-ui,sans-serif;margin:0;background:#f4f4f5;color:#1c1b19}.wrap{max-width:900px;margin:0 auto;padding:32px}h1{font-size:22px;margin:0 0 4px}.sub{color:#6b6a66;font-size:14px}.card{display:block;background:#fff;border:1px solid #e6e4df;border-radius:12px;padding:16px 18px;margin:10px 0;text-decoration:none;color:inherit;font-weight:700}.card:hover{border-color:#c8102e}code{background:rgba(0,0,0,.06);padding:1px 6px;border-radius:5px}</style><div class=wrap><h1>📊 MUST IT 데이터 대시보드</h1><p class=sub>직원이 만든 대시보드 모음. 새 대시보드는 <code>dashboards/</code> 폴더에 HTML 파일을 추가하고 push하면 여기 자동 표시됩니다.</p>${cards || '<p class=sub>아직 대시보드가 없습니다.</p>'}</div>`;
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    // 로그인
    if (p === "/api/login" && req.method === "POST") {
      const b = JSON.parse((await body(req)) || "{}");
      if (PW && b.password === PW) return send(res, 200, "application/json", '{"ok":true}', { "Set-Cookie": `dash_auth=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
      return send(res, 401, "application/json", '{"ok":false}');
    }
    // 인증 게이트 (미인증이면 로그인 화면)
    if (!authed(req)) return send(res, 200, "text/html; charset=utf-8", LOGIN);
    // 데이터 API (읽기전용 RPC 프록시)
    if (p === "/api/q" && req.method === "POST") {
      const b = JSON.parse((await body(req)) || "{}");
      const r = await fetch(SB + "/rest/v1/rpc/dash_query", { method: "POST", headers: H, body: JSON.stringify({ q: b.sql || b.q || "" }) });
      return send(res, r.status, "application/json; charset=utf-8", await r.text());
    }
    // 클라이언트 헬퍼
    if (p === "/dash.js") return send(res, 200, "application/javascript; charset=utf-8", DASHJS);
    // 개별 대시보드 파일 (/d/<이름>)
    const m = p.match(/^\/d\/(.+)$/);
    if (m) {
      const safe = decodeURIComponent(m[1]).replace(/[^a-zA-Z0-9_\-가-힣]/g, "");
      const f = path.join(DASHDIR, safe + ".html");
      if (fs.existsSync(f)) return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(f));
      return send(res, 404, "text/html; charset=utf-8", "대시보드를 찾을 수 없습니다");
    }
    // 인덱스
    return send(res, 200, "text/html; charset=utf-8", indexPage());
  } catch (e) { send(res, 500, "application/json", JSON.stringify({ error: String(e) })); }
}).listen(PORT, () => console.log("dashboards up on :" + PORT));
