# CLAUDE.md — MUST IT 대시보드 레포 개발 지침

이 파일은 Claude Code가 이 레포에서 작업할 때 자동으로 읽는 지침입니다. **대시보드를 만들거나 고칠 때 아래 규칙을 지키세요.**

## 이 레포가 뭔가
- 정적 사이트(GitHub Pages). 빌드 없음. `main`에 push → 자동 배포.
- 브라우저가 **서울 Supabase**(ref `hhvmhtejmhhxksnldfmi`)의 집계 RPC를 직접 호출.
- **대시보드 1개 = `dashboards/` 폴더의 HTML 파일 1개** (자기완결형). `dashboards.json`에 목록 등록.

## 로그인·데이터 접근 (중요)
- 사이트 전체가 **로그인 게이트**(Supabase Auth). 페이지에 아래를 넣고, 데이터는 로그인 후에만 로드:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script src="../auth.js"></script>
  ```
  ```js
  window.MUSTIT.ready(function(){ /* 여기서 MUSTIT.rpc(...) 호출 */ });
  ```
- 데이터는 **반드시 `window.MUSTIT.rpc(함수, {p})`** 로 가져온다. 직접 fetch로 publishable 키를 Bearer에 넣지 말 것(로그인 토큰을 써야 함).
- 제공 RPC: `dash_summary` `dash_daily` `dash_coupon` `dash_raw`(89컬럼) `dash_raw_all`(99컬럼, 로그인전용) `dash_filters`. 입력 `p = {from,to,filters:{컬럼:[값]},product_name}`.

## 절대 규칙
1. **일시는 이미 KST** → `AT TIME ZONE` 금지. `order_datetime` 그대로. 기간 필터는 인덱스를 타서 빠름 — 항상 기간을 좁힐 것.
2. **재무 정의**: 매출=`gross_revenue`(총매출), 거래액/GMV=`total_purchase`, 순매출=총매출−자사할인, 순이익=순매출−결제수수료. 마스터뷰 기본은 **전체 주문상태**(정산완료만 보려면 `filters.order_status:["정산완료"]`).
3. **보안**: `service_role` 키를 프런트에 절대 넣지 말 것(계정관리 같은 관리자 기능은 Edge Function `admin-users` 서버측에서만). 개인정보 컬럼은 로그인+허용목록(`dash_allowed`)으로만 접근. 새 RPC를 만들면 `anon`에는 주지 말고 `authenticated`+`_dash_guard()` 검사를 넣을 것.
4. 새 대시보드는 기존 파일을 건드리지 말고 **새 HTML 파일**로 추가 (동시 작업 충돌 방지).

## 새 대시보드 추가 순서
1. `dashboards/내대시보드.html` 생성 (기존 `전체주문_주문일_Master.html` 구조 참고: auth 스크립트 + MUSTIT.ready + ECharts).
2. `dashboards.json`에 `{ "file": "...", "title": "...", "icon": "📊" }` 추가.
3. `git add -A && git commit -m "..." && git push` → 몇 분 뒤 Pages 반영. (캐시면 Ctrl+F5)

## 하지 말 것
- 원본 `mustit_orders.orders`(관리자 전용) 접근, `AT TIME ZONE` 사용, service_role 노출, 다른 사람 대시보드 파일 임의 수정, 개인정보를 게이트 밖으로 노출.
