// 대시보드 썸네일 스냅샷 생성기
// - 각 대시보드의 #thumb 화면을 Playwright로 캡처 → 비공개 Supabase Storage(dash-thumbs)에 업로드
// - 세션은 service_role로 매직링크를 발급받아 생성(비밀번호 불필요)
// 실행:
//   cd tools && npm i && npx playwright install chromium
//   (PowerShell) $env:SUPABASE_SERVICE_ROLE_KEY="..."; node gen-thumbs.mjs
// 선택 환경변수: CAPTURE_EMAIL(기본 ceo@mustit.co.kr, 전체 열람용 admin), PAGES_BASE, ONLY(쉼표구분 파일만)
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const URL   = process.env.SUPABASE_URL || 'https://hhvmhtejmhhxksnldfmi.supabase.co';
const ANON  = process.env.SUPABASE_ANON_KEY || 'sb_publishable_3qHI5hEv90wiU03q3mmS4Q_nUdAovOw';
const SR    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = (process.env.CAPTURE_EMAIL || 'ceo@mustit.co.kr').toLowerCase();
const PAGES = (process.env.PAGES_BASE || 'https://mustit-ai.github.io/mustit-data-portal-dashboards').replace(/\/$/, '');
const ONLY  = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const STORAGE_KEY = 'mustit-dash-auth';
const BUCKET = 'dash-thumbs';

if (!SR) { console.error('환경변수 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.'); process.exit(1); }

const admin = createClient(URL, SR, { auth: { persistSession: false } });

// 1) service_role 매직링크 → 세션 발급(비밀번호 없이). auth.js와 동일 storageKey로 직렬화 문자열 확보
const store = {};
const mem = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
const authClient = createClient(URL, ANON, { auth: { persistSession: true, storageKey: STORAGE_KEY, storage: mem, autoRefreshToken: false } });
{
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) { console.error('매직링크 생성 실패:', error.message); process.exit(1); }
  const th = link?.properties?.hashed_token;
  if (!th) { console.error('hashed_token 없음'); process.exit(1); }
  const { error: ve } = await authClient.auth.verifyOtp({ token_hash: th, type: 'magiclink' });
  if (ve) { console.error('세션 생성 실패:', ve.message); process.exit(1); }
}
const authValue = store[STORAGE_KEY];
if (!authValue) { console.error('세션 직렬화 실패'); process.exit(1); }

// 2) 대상 대시보드 목록
const { data: rows, error: le } = await admin.from('dashboards').select('file').order('created_at');
if (le) { console.error('목록 조회 실패:', le.message); process.exit(1); }
let files = (rows || []).map(r => r.file);
if (ONLY.length) files = files.filter(f => ONLY.includes(f));

// 3) 캡처 + 업로드
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1280 }, deviceScaleFactor: 1 });
await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [STORAGE_KEY, authValue]);
const page = await ctx.newPage();

let ok = 0, skip = 0, fail = 0;
for (const file of files) {
  const url = `${PAGES}/dashboards/${encodeURIComponent(file)}`;
  let built = false;
  try { const r = await fetch(url, { method: 'HEAD' }); built = r.ok; } catch (e) {}
  if (!built) { skip++; console.log('건너뜀(준비중):', file); continue; }
  try {
    await page.goto(url + '#thumb', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4500); // 차트 렌더 대기
    const buf = await page.screenshot({ type: 'png' });
    const { error: ue } = await admin.storage.from(BUCKET).upload(file + '.png', buf, { contentType: 'image/png', upsert: true });
    if (ue) { fail++; console.error('업로드 실패:', file, ue.message); }
    else { ok++; console.log('완료:', file, ((buf.length / 1024) | 0) + 'KB'); }
  } catch (e) { fail++; console.error('캡처 실패:', file, e.message); }
}
await browser.close();
console.log(`\n스냅샷 ${ok}개 · 준비중 ${skip}개 · 실패 ${fail}개`);
process.exit(0);
