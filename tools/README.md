# 대시보드 썸네일 스냅샷

홈 카드의 미리보기를 **실시간 iframe → 정적 이미지 스냅샷**으로 제공한다.
스냅샷은 **비공개** Supabase Storage 버킷 `dash-thumbs`에 저장되고, 홈은 로그인 사용자에게만 **서명 URL**로 이미지를 보여준다(공개 노출 없음). 스냅샷이 없으면 자동으로 기존 iframe 미리보기로 폴백한다.

## 실행 (수동 갱신)
```bash
cd tools
npm i
npx playwright install chromium
# PowerShell — service_role 키만 있으면 됨(비밀번호 불필요)
$env:SUPABASE_SERVICE_ROLE_KEY="<서비스롤키>"
node gen-thumbs.mjs
```
- 특정 대시보드만: `$env:ONLY="openapi-live-orders.html,all-orders-master.html"; node gen-thumbs.mjs`
- 캡처 계정 변경(기본 admin `ceo@mustit.co.kr`, 전체 열람 위해 admin 권장): `$env:CAPTURE_EMAIL="..."`

## 자동 갱신 (설정됨)
- **Windows 작업 스케줄러 `MustitDashThumbs`** 가 **매일 08:10**(PC가 꺼져 있었으면 다음 켜질 때) `run-thumbs.ps1` 실행 → 전체 스냅샷 갱신. 로그: `tools/thumbs.log`.
  - 즉시 실행: `Start-ScheduledTask -TaskName MustitDashThumbs`
  - 시간 변경/삭제: `Get-ScheduledTask MustitDashThumbs` / `Unregister-ScheduledTask MustitDashThumbs`
  - 키는 `mustit-orders\.env`의 `SUPABASE_SERVICE_ROLE_KEY`를 읽어 주입(스크립트에 비밀 없음).
- (대안) **GitHub Actions**: `.github/workflows/thumbs.yml`(로컬에 준비됨) + 리포 Secret `SUPABASE_SERVICE_ROLE_KEY`(등록됨)로 클라우드 스케줄 실행 가능. 단, 워크플로 파일 push에는 gh 토큰 `workflow` 스코프가 필요(`gh auth refresh -s workflow` 후 push).

## 동작 원리
1. `service_role`로 매직링크(`generateLink`) 발급 → `verifyOtp`로 세션 생성(비번 없이).
2. `auth.js`와 동일한 `storageKey`(`mustit-dash-auth`)로 세션을 직렬화해 브라우저 localStorage에 주입.
3. 각 대시보드 `#thumb` 페이지를 1280×1280로 캡처(무거운 RAW는 `#thumb`에서 스킵됨).
4. PNG를 `dash-thumbs/<file>.png` 로 업서트.

⚠️ `SUPABASE_SERVICE_ROLE_KEY`는 비밀. **커밋 금지**(이 폴더 `.gitignore`가 `.env` 제외). 로컬 env로만 사용.
