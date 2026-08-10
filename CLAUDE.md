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

## 권한·소유권 (중요)
계정 관리(admin.html)에서 계정별로 설정: **역할**(viewer/editor/admin), **GitHub 아이디**(`github_id`), **개인정보 열람**(`can_view_pii`), 그리고 **대시보드별 열람/수정**(`dashboard_acl`).

- **개인정보 열람**: `can_view_pii`=true 인 계정만 RAW 전체 99컬럼(`dash_raw_all`) 조회 가능(DB에서 강제). 없으면 🔓 버튼 숨김.
- **대시보드별 열람**: `dashboard_acl(dashboard,email,can_view,can_edit)`. 대시보드는 로드 시 `dash_access(파일명)` 로 열람권 확인 → 없으면 화면 차단(페이지 레벨). ACL 미설정 대시보드는 로그인 전원 열람. admin은 항상 전체.
- **대시보드별 수정**: `dashboard_acl.can_edit`(+ `dashboards.json.owner`)로 표시하지만 **파일 수정은 앱이 강제 못 함** → 아래 규칙(관례)으로 지킴. 진짜 강제는 GitHub 브랜치보호+CODEOWNERS(`github_id` 사용).

- **각 대시보드에는 소유자(owner)가 있다** — `dashboards.json` 항목의 `"owner"`(이메일).
- **Claude로 작업할 때 소유권 규칙**:
  1. 작업 시작 시 개발자에게 본인 로그인 이메일을 확인한다(모르면 물어본다).
  2. **기존 대시보드는 그 파일의 `owner` 와 본인 이메일이 같을 때만 수정**한다. 남의 소유 대시보드는 고치지 말 것(요청받아도 소유자 확인/승인 없이는 금지).
  3. **새 대시보드를 만들면 `dashboards.json` 항목의 `owner` 를 본인 이메일로** 넣는다.
  4. `viewer` 역할 사용자를 위한 작업이면 대시보드 생성·수정을 하지 말 것(열람 전용).
- 이 규칙은 팀 협업용 관례다. **파일 수정을 물리적으로 강제**하려면 GitHub 브랜치보호+CODEOWNERS(관리자에게 문의). 열람 제한(특정 대시보드를 특정 역할만)이 필요하면 데이터단 ACL을 별도 구축.

## 새 대시보드 추가 순서
대시보드 목록·이름의 source of truth는 **DB `public.dashboards`**(정적 `dashboards.json`은 레거시·미사용). 이름은 `title` 하나만 사용(짧은이름 없음).

**권장 흐름**: 사용자가 **대시보드 홈의 "+ 대시보드 생성"** 으로 먼저 만든다 → 생성자가 owner, 권한 지정, `dashboards` 행 + **ASCII 파일명(`d-xxxx.html`) 자동 생성**, `built=false`. 이 상태면 카드에 **"준비중"** 표시 + 열면 `dashboards/_starter.html?f=<file>`(상단바+제작 가이드)이 뜬다. 개발자가 그 파일을 실제로 만들면 완성.

**제작 완료 시 반드시 `built=true`**: 실제 `dashboards/<file>` 를 만들고 push한 뒤, `update public.dashboards set built=true where file='<file>';` (또는 admin-users `dash_meta_set {file, built:true}`) 실행 → 그때부터 카드가 실제 파일로 연결됨.

1. 홈에서 생성된 대시보드의 **파일명** 확인(생성 시 안내됨). 없으면 SQL로 등록: `insert into public.dashboards(file,title,icon,owner_email) values ('내대시보드.html','이름','📊','소유자이메일');`
2. `dashboards/<파일명>` 생성 (기존 `all-orders-master.html` 구조 참고: auth 스크립트 + `MUSTIT.ready` + `dash_access(파일명)` 열람체크 + 헤더/네비는 `dash_list()`, ECharts).
3. **소유권 규칙(재확인)**: 기존 대시보드는 `dash_access(파일명).edit` 이 true(= owner 이거나 acl can_edit)일 때만 수정. **owner 가 아니면 그 대시보드 HTML을 수정하지 말 것.** 새로 만들면 owner=만든 사람.
4. `git add -A && git commit -m "..." && git push` → 몇 분 뒤 Pages 반영. (캐시면 Ctrl+F5)

## 하지 말 것
- 원본 `mustit_orders.orders`(관리자 전용) 접근, `AT TIME ZONE` 사용, service_role 노출, 다른 사람 대시보드 파일 임의 수정, 개인정보를 게이트 밖으로 노출.
