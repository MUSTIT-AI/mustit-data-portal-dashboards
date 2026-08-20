# CLAUDE.md — MUST IT 대시보드 레포 개발 지침

이 파일은 Claude Code가 이 레포에서 작업할 때 자동으로 읽는 지침입니다. **대시보드를 만들거나 고칠 때 아래 규칙을 지키세요.**

## 이 레포가 뭔가
- 정적 사이트(GitHub Pages). 빌드 없음. `main`에 push → 자동 배포.
- 브라우저가 **서울 Supabase**(ref `hhvmhtejmhhxksnldfmi`)의 집계 RPC를 직접 호출.
- **대시보드 1개 = `dashboards/` 폴더의 HTML 파일 1개** (자기완결형). `dashboards.json`에 목록 등록.
- **데이터 소스 3종**(아래 각 절 참고 · 서로 조인 가능): ① **주문**(퀵사이트 지표 · `orders_secure`/RPC) · ② **Open API 상품·카탈로그**(`mustit_*` 뷰/RPC) · ③ **앰플리튜드**(행동·유입 · `amplitude-proxy`).

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
- 제공 RPC: `dash_summary` `dash_daily` `dash_coupon` `dash_raw`(89컬럼) `dash_raw_all`(99컬럼, 로그인전용) `dash_filters` `dash_product_rank`(상품 랭킹 집계). 입력 `p = {from,to,filters:{컬럼:[값]},product_name}`.
- **집계는 원본을 내려받지 말고 DB에서 집계할 것 (중요)**: 상품·브랜드 랭킹, 카테고리 비중처럼 "집계가 목적"인 화면은 `dash_raw`로 원본 행을 브라우저로 당겨 접는 방식이 매우 비효율적이다(1년 ≈ 300MB, 왕복 수백 회, 타임아웃 위험). **DB 집계 RPC를 쓰거나 새로 만들 것.** 예: `dash_product_rank(p, p_limit)` = 상품별 GMV·수량·할인·순위(rank)를 한 번에 반환(90일도 ~2초·100행). 같은 패턴으로 필요한 집계 RPC를 추가(SECURITY DEFINER + `_dash_where`).
- **RAW 행수 상한 & 실질 한계(타임아웃)**: `p_limit` 최대 100,000이지만 **실질 한계는 `authenticated`의 8초 쿼리 타임아웃**이다(무필터 기준 약 19,000행 ≈ 2개월). 그보다 긴 기간에 `p_limit=100000`을 넣으면 **타임아웃(57014)** 난다. → 긴 기간은 **기간을 잘라 여러 번 호출해 합산**할 것. **동시 호출 시엔 쿼리 경합으로 더 빨리 타임아웃**나므로 건당 **2,000행 수준**으로 잡을 것(여러 대시보드를 동시에 열 때도 실패 가능). 반환행수가 `p_limit`과 같으면 잘린 것. KPI·차트(`dash_summary`/`dash_daily`/`dash_coupon`)와 집계 RPC는 서버 집계라 이 문제와 무관 → **가능하면 집계 RPC를 쓸 것.**
- **필터는 화이트리스트만 적용됨(주의)**: `_dash_where`의 허용 컬럼만 `filters`로 걸린다. 목록에 없는 키는 **에러 없이 조용히 무시**되어 "필터가 걸린 줄 알고 잘못된 결과"를 보게 되니, 없는 컬럼은 클라이언트에서 거를 것. 허용: brand, order_type, category_gender, category_code, category_l, category_m, **category_s**, order_status, product_division, platform, payment_method, member_grade, age_band, buyer_gender, region_sido, customer_type, seller_id, seller_grade, join_year, ship_origin, courier, naver_discount_applied. (category_s는 2026-08-10 추가됨)
- **카테고리 드릴다운**: `dash_filters()`가 `category_l`(대) + `category_tree`(대>중>소 조합 배열 `[{l,m,s}]`)를 반환한다. 하드코딩하지 말고 `category_tree`에서 중/소 목록·계층을 파생할 것.
- (레거시) `dash_raw_full`(비밀번호 게이트)은 상한 2,000 그대로·미사용. 전체 컬럼은 로그인 게이트 `dash_raw_all`을 쓸 것.

- **홈 썸네일 절감(필수 규약)**: 홈 갤러리는 각 대시보드를 `dashboards/<file>#thumb` iframe으로 띄워 미리보기한다. 대시보드는 **`location.hash`에 `thumb`이 있으면 무거운 조회(RAW 대용량 `dash_raw`/`dash_raw_all`, 수천 행 `orders_secure` 등)를 건너뛰고** 가벼운 차트(집계 RPC)만 렌더할 것. 예: `var THUMB=location.hash.indexOf('thumb')>=0; if(THUMB) return;`(RAW 로드 스킵). 안 지키면 홈 열 때마다 대시보드 수 × 전체 데이터가 재조회돼 트래픽·DB 부하가 커진다.

### 직접 쿼리: `public.orders_secure` 뷰 (원하는 집계를 RPC 없이)
정해진 RPC로 부족하면 **`public.orders_secure` 뷰를 직접 쿼리**해서 자유롭게 필터·집계할 수 있다. `mustit_orders.orders_v`(직접 접근 불가)와 달리 이 뷰는 로그인 계정이 조회 가능하다.
- **개인정보 자동 마스킹**: 뷰가 로그인 계정의 `can_view_pii`를 DB에서 판정 → 권한 있으면 99컬럼 전부, 없으면 개인정보 10컬럼(age_band·buyer_gender·member_no·buyer_hash·region_sido·region_sigungu·buyer_age·join_year·join_date·prev_order_at)이 **NULL**로 나온다. 허용목록에 없으면 0행.
- 컬럼 타입은 원본 그대로(날짜=timestamp) → 기간·집계 쿼리에 그대로 사용. 일시는 이미 KST(`AT TIME ZONE` 금지).
- 호출(로그인 세션의 JWT 자동 사용):
  ```js
  window.MUSTIT.ready(function(){
    window.MUSTIT.client.from('orders_secure')
      .select('brand,total_purchase,order_datetime')
      .gte('order_datetime','2026-07-01').lt('order_datetime','2026-08-01')
      .limit(1000)
      .then(function(res){ var rows = res.data||[]; /* 차트 그리기 */ });
  });
  ```
- PostgREST 기본 응답 상한(~1000행)·집계 한계가 있으니, **대용량·복잡 집계는 여전히 전용 RPC**(SECURITY DEFINER + `_dash_guard()`)가 낫다. 단순 조회·필터·중간규모는 이 뷰가 편하다.

## 앰플리튜드(Amplitude) 데이터
앰플리튜드 지표는 Edge Function 프록시로 가져온다. 키는 Supabase 시크릿(`AMPLITUDE_API_KEY`/`AMPLITUDE_SECRET_KEY`)에만 있고 프런트엔 절대 넣지 말 것. 프로젝트=`Live_real_MUSTIT`(540504).
- 호출: `window.MUSTIT.fn("amplitude-proxy", { endpoint, params })` → `res.data` = Amplitude Dashboard REST 응답. 로그인 게이트 적용, 429 자동 재시도 내장.
  ```js
  window.MUSTIT.fn("amplitude-proxy",{ endpoint:"events/segmentation", params:{
    e:[JSON.stringify({event_type:"complete_order",filters:[{subprop_type:"user",subprop_key:"country",subprop_op:"is",subprop_value:["South Korea"]}]})],
    m:"uniques", i:7, start:"20260701", end:"20260731",
    s:[JSON.stringify([{prop:"os",op:"does not contain",values:["yeti","bot","headless"]}])]  // 세그먼트(선택)
  }}).then(function(r){ var d=r.data.data; /* d.series, d.xValues, d.seriesLabels */ });
  ```
  - `params`는 Amplitude REST 파라미터 그대로: `e`(이벤트 JSON 문자열 배열), `m`(uniques/totals/…), `i`(1일/7주/30월), `start`/`end`(YYYYMMDD), `s`(세그먼트 JSON 문자열 배열, 여러 개=여러 시리즈), `g`/event.group_by(그룹바이). 배열은 프록시가 반복 파라미터로 전개.
  - 허용 endpoint: `events/segmentation` `funnels` `retention` `users` `composition` `sessions/*` `events/list` `annotations`.
- **429(호출량 제한)**: 차트 여러 개는 **순차 호출**(Promise.all 금지). 매일 보는 무거운 지표는 **하루 1회 캐시**로: Amplitude→Supabase 테이블 적재(예: `amp_daily`, Edge `amp-sync`)→RPC로 조회. 캐시가 429·속도 모두 해결.
- **주문 데이터와 조인**: **날짜/카테고리/플랫폼 차원 조인 권장**(집계끼리 공통 축 결합). 예: RPC `dash_daily_conversion`(`amp_daily` ⨝ `orders_v` by date → 방문자·주문·전환율·RPU). 주문단위(order_no)도 되지만 **유입경로(referrer)·광고 attribution은 주문 이벤트에 안 실림**(세션 단위)이라 행 레벨 유입 귀속은 불가.
- 참고 구현: `dashboards/amplitude-au-core.html`(순수 앰플), `dashboards/daily-conversion.html`(날짜 조인).

## 머스트잇 Open API — 상품·카탈로그 마스터 (`mustit_api`)
머스트잇 파트너 OpenAPI로 **매일 08:00 KST 자동 적재**되는 상품·카탈로그 마스터(Edge `openapi-daily-sync` + pg_cron). **비(非)개인정보**라 로그인 계정 누구나 조회 가능. 자격증명은 서버(Vault)에만 있고, 대시보드는 아래 뷰/RPC만 쓰면 됨(키 불필요).

- **public 뷰 (로그인=`authenticated` 조회 가능)**:
  - `mustit_products` (상품 마스터, ~340만) — `item_no, catalog_id, item_name, seller_id, stock, selling_price, product_status`(IN_STOCK/OUT_OF_STOCK/SUSPENDED)`, brand_code, category, created_at, updated_at`
  - `mustit_catalogs` — `catalog_id, brand_name, brand_code, catalog_name, category, category_code, main_image_url, refine_image_url, serial_no, model_no, color_no, created_at`
  - `mustit_brands` (2,279) — `brand_code, brand_kor, brand_eng`
  - `mustit_categories` (492) — `category_code, category_name, level, parent_code, header_category_type`
  - 조회(로그인 JWT 자동, `orders_secure`와 동일 방식):
    ```js
    window.MUSTIT.ready(function(){
      window.MUSTIT.client.from('mustit_brands').select('brand_code,brand_kor').limit(50)
        .then(function(r){ var rows=r.data||[]; /* 차트 */ });
    });
    ```
- **⚠️ 상품은 ~340만 행 → 브라우저로 당겨 집계 절대 금지.** 브랜드별·카테고리별 집계 등은 **DB 집계 RPC**를 쓸 것. 준비된 예: `mustit_products_by_brand(p_limit)` → 브랜드별 상품수·평균가(순위).
  ```js
  window.MUSTIT.rpc('mustit_products_by_brand', {p_limit:20}).then(function(r){ /* r = [{brand_code,brand_kor,brand_eng,product_count,avg_price}] */ });
  ```
  새 집계가 필요하면 같은 패턴으로 RPC 추가: `language sql/plpgsql security definer set search_path=''`, `mustit_api.*` 조회, `authenticated`(+`anon`)에 execute grant.
- **주문 데이터와 조인**: 공통 키 `brand_code`(→`mustit_brands`), `category`(카테고리 코드), `catalog_id`로 `orders_secure`/`orders_v`와 결합. 예: 주문 판매 상위 상품 × `mustit_products`로 상품명·카탈로그·가격 붙이기.
- **날짜는 KST**(`created_at` 등 그대로, `AT TIME ZONE` 금지). **적재 주기**: 매일 08:00 — 브랜드·카테고리 전체 갱신 + 신규 상품/카탈로그 증분. **가격·재고 실시간 변경은 미반영**(신규 등록 기준)이라 최신 가격이 꼭 필요하면 별도 확인.

## 절대 규칙
> **공통 분석 지침의 단일 출처(SSOT) = DB.** 대시보드를 만들거나 데이터를 분석하기 전에 먼저 아래를 실행해 최신 공통 지침을 읽고 그 규칙을 반드시 따르라:
> ```sql
> select content from public.portal_guidelines order by updated_at desc;
> ```
> 아래 재무 정의·시간대 규칙은 **편의용 사본**이며, **충돌하면 `portal_guidelines`가 우선**한다. 공통 규칙 변경은 포털 "③ 공통 지침"(=이 테이블)에서만 하고 여기(CLAUDE.md)엔 개발 전용 규칙만 둔다.

1. **일시는 이미 KST** → `AT TIME ZONE` 금지. `order_datetime` 그대로. 기간 필터는 인덱스를 타서 빠름 — 항상 기간을 좁힐 것.
2. **재무 정의**: 매출=`gross_revenue`(총매출), 거래액/GMV=`total_purchase`, 순매출=총매출−자사할인, 순이익=순매출−결제수수료. 마스터뷰 기본은 **전체 주문상태**(정산완료만 보려면 `filters.order_status:["정산완료"]`).
3. **보안**: `service_role` 키를 프런트에 절대 넣지 말 것(계정관리 같은 관리자 기능은 Edge Function `admin-users` 서버측에서만). 개인정보 컬럼은 로그인+허용목록(`dash_allowed`)으로만 접근. 새 RPC를 만들면 `anon`에는 주지 말고 `authenticated`+`_dash_guard()` 검사를 넣을 것.
4. 새 대시보드는 기존 파일을 건드리지 말고 **새 HTML 파일**로 추가 (동시 작업 충돌 방지).
5. **필터는 항상 복수 선택 가능하게** — 단일 `<select>` 금지, **체크박스 드롭다운(다중선택)** 으로 구현. 미선택=전체, 선택 시 서버에 배열로 전달해 `in` 필터. 참고 구현: `dashboards/openapi-live-orders.html`의 `.ms` 멀티셀렉트(buildFilters/getFilters). 결제수단은 **외부결제 vs 중개거래(그 외 전부)** 2버킷으로 집계·필터(Edge `openapi-orders`의 payBucket).
6. **파비콘·타이틀 통일** — 모든 페이지 `<head>`에 `<link rel="icon" type="image/svg+xml" href="favicon.svg">`(루트) 또는 `../favicon.svg`(dashboards/). 브라우저 탭 제목은 **`Data Portal - {대시보드명}`** 으로 — `setupTopbar`에서 `document.title="Data Portal - "+(cur.title||FILE)` 동적 설정.
7. **전체 폭 사용 + 반응형(필수)** — 본문은 **화면 너비 100%** 로 쓴다(`max-width` 고정 금지, `.wrap{max-width:100%;padding:14px 20px}`). 레이아웃은 **반응형**: 차트 그리드는 `grid-template-columns` + `@media(max-width:1100px/640px)`로 열 수를 줄이고, 차트 컨테이너는 `width:100%`, ECharts는 `window resize`에서 `el.resize()` 호출. 막대 굵기도 고정폭 대신 `barMaxWidth`(예: 40)로 화면 폭에 따라 조절, 데이터 레이블은 단위 축약(M/k). 참고: `dashboards/openapi-live-orders.html`.
8. **메타데이터 필수 기입(색인·검색용)** — 대시보드 생성/등록 시 `dashboards` 행에 항상 채운다: **`title`**(목적별 자유 명칭) · **`short`**(한 줄 설명: 어떤 데이터를 보는지) · **`tags text[]`**(도메인 태그, 예: `{주문,매출}`; 권장 어휘 #주문 #행동 #카탈로그 #상품 #마케팅 #회원 #전환 #매출). 홈은 설명·태그를 카드에 표시하고 **검색 대상**으로 쓴다. 생성/수정은 Edge `admin-users`의 `dash_create`/`dash_meta_set`(파라미터 `short`,`tags`). SQL 직접 등록 시에도 `short`,`tags`를 넣을 것.
9. **열람 권한·소유권·폴더(홈 기능)** — 열람 권한 부여/회수는 **소유자·관리자**가 홈 카드 **⚙️ 관리·공유** 모달에서 수행(전체 열람 ↔ 지정 계정만, 계정별 열람/수정 즉시 반영). Edge `admin-users`: `acl_list`/`acl_set`/`acl_reset_all`. **소유권 이관**=`dash_transfer_owner`(소유자·관리자). **삭제**=`dash_delete`(소유자·관리자, 홈에서 비밀번호 재확인). **개인 폴더**(계정별, 한 대시보드 여러 폴더)=RPC `dash_folders`/`dash_folder_create`/`dash_folder_rename`/`dash_folder_delete`/`dash_folder_set`. **즐겨찾기**=`dash_favs`/`dash_fav_set`. 홈 카드 일자는 **GitHub 파일 최종 커밋일**(공개 레포 API, 12h 캐시); `dashboards.updated_at`은 메타 변경 시각이라 표시용으로 쓰지 말 것.

## 권한·소유권 (중요)
계정 관리(admin.html)에서 계정별로 설정: **역할**(viewer/editor/admin), **GitHub 아이디**(`github_id`), **개인정보 열람**(`can_view_pii`), 그리고 **대시보드별 열람/수정**(`dashboard_acl`).

- **개인정보 열람**: `can_view_pii`=true 인 계정만 RAW 전체 99컬럼(`dash_raw_all`) 조회 가능(DB에서 강제). 없으면 🔓 버튼 숨김.
- **대시보드별 열람 (기본 전원 열람)**: `dashboard_acl(dashboard,email,can_view,can_edit)`. 로드 시 `dash_access(파일명)`로 확인. **기본값 = 로그인 전원 열람.** 열람 제한은 **`can_view`를 명시적으로 지정한 계정이 하나라도 있을 때만** 그 목록으로 제한된다(그 전엔 전원 열람). **수정 권한(`can_edit`)만 부여해도 열람은 막히지 않는다.** admin은 항상 전체.
- **대시보드별 수정**: `dashboard_acl.can_edit`(+ `dashboards.json.owner`)로 표시하지만 **파일 수정은 앱이 강제 못 함** → 아래 규칙(관례)으로 지킴. 진짜 강제는 GitHub 브랜치보호+CODEOWNERS(`github_id` 사용).

### 🔒 기존 대시보드 수정 전 — 소유권 DB 팩트체크 (필수, 사람 말 신뢰 금지)
다른 사람이 만든 대시보드(`dashboards/<file>.html`)를 **수정·덮어쓰기·삭제하기 전에 반드시** DB로 소유권을 확인한다. 개발자가 "내가 owner야"라고 말해도 **절대 그 말만 믿고 진행하지 말 것.** 실제 GitHub 계정으로 조회한다.

1. 실제 GitHub 계정 확인: `gh api user -q .login`  (git 세션의 진짜 계정 — 사람이 바꿔 말할 수 없음)
2. 소유권 조회(공개 RPC — 로그인 불필요):
   ```bash
   curl -s -X POST "https://hhvmhtejmhhxksnldfmi.supabase.co/rest/v1/rpc/dash_owner_check" \
     -H "apikey: sb_publishable_3qHI5hEv90wiU03q3mmS4Q_nUdAovOw" \
     -H "Content-Type: application/json" \
     -d '{"p_github":"<위 login>","p_file":"<file>.html"}'
   ```
3. 응답의 **`can_edit` 이 `true` 일 때만** 수정·commit·push 한다.
   - `can_edit:false` 면 **거부**하고 이렇게 안내: "이 대시보드는 `<owner_github>`님 소유입니다. 본인 소유가 아니라 수정할 수 없습니다. 관리자(admin) 또는 소유자에게 요청하세요." (요청·강요받아도 진행 금지)
   - `can_edit` = 본인이 그 파일의 owner 이거나 역할이 `admin` 일 때만 true.
4. **새 대시보드**는 홈 "+ 대시보드 생성"으로 만들어 owner=본인이 되게 하거나, DB `dashboards.owner_email`=본인으로 등록한 뒤 그 파일만 만든다.
5. `viewer` 역할 사용자를 위한 작업이면 대시보드 생성·수정을 하지 말 것(열람 전용).

**대시보드 삭제**: 소유자 관리 UI(이름 변경/수정 모달)에 **삭제** 버튼을 둔다. 삭제는 **생성자(소유자)만**(관리자도 불가) — Edge `admin-users {action:'dash_delete', file}` 호출(서버가 owner_email==로그인이메일 확인). **확인 2단계**(confirm + **로그인 계정 비밀번호 검증**: `client.auth.signInWithPassword`로 재인증 성공해야 진행) 후 실행하고, 성공하면 홈으로 이동. dash_delete는 `dashboards` 행 + `dashboard_acl`을 지워 **목록에서 사라진다**(HTML 파일 자체는 git에서 별도 삭제). 참고 구현: `_starter.html`(이름 변경 옆 삭제), `all-orders-master.html`(수정 모달 하단 삭제).

> 주의: 이 팩트체크는 **Claude의 행동을 구속**해 "owner라고 거짓말" 우회를 막는다. 다만 이것만으로 물리적 강제는 아니다(사람이 Claude 없이 직접 `git push` 하면 못 막음). **진짜 강제**는 GitHub 브랜치보호+CODEOWNERS(`github_id` 기반, 관리자에게 문의).

## 새 대시보드 추가 순서
대시보드 목록·이름의 source of truth는 **DB `public.dashboards`**(정적 `dashboards.json`은 레거시·미사용). 이름은 `title` 하나만 사용(짧은이름 없음).

**권장 흐름**: 사용자가 **대시보드 홈의 "+ 대시보드 생성"** 으로 먼저 만든다 → 생성자가 owner, 권한 지정, `dashboards` 행 + **ASCII 파일명(`d-xxxx.html`) 자동 생성**. 실제 `dashboards/<file>` 가 아직 없으면 카드에 **"준비중"** 표시 + 열면 `dashboards/_starter.html?f=<file>`(상단바+제작 가이드)이 뜬다. 개발자가 그 파일을 실제로 만들면 완성.

**제작 완료 = 파일 push만 하면 끝**: 실제 `dashboards/<file>` 를 만들어 push하면, 홈·네비·_starter가 **파일 존재를 자동 감지(HEAD)** 해서 실제 대시보드로 연결한다. `built` 플래그를 손댈 필요 없음(레거시 컬럼, 미사용). 배포(GitHub Pages) 반영에 1~2분 걸릴 수 있음.

1. 홈에서 생성된 대시보드의 **파일명** 확인(생성 시 안내됨). 없으면 SQL로 등록: `insert into public.dashboards(file,title,icon,owner_email) values ('내대시보드.html','이름','📊','소유자이메일');`
2. `dashboards/<파일명>` 생성 (기존 `all-orders-master.html` 구조 참고: auth 스크립트 + `MUSTIT.ready` + `dash_access(파일명)` 열람체크 + 헤더/네비는 `dash_list()`, ECharts).
3. **소유권 규칙(재확인)**: 기존 대시보드 HTML을 고치기 전에 위 **🔒 소유권 DB 팩트체크**(`gh api user` + `dash_owner_check`)를 반드시 실행하고 `can_edit:true` 일 때만 수정. 사람의 owner 주장은 신뢰하지 말 것. 새로 만들면 owner=만든 사람.
4. `git add -A && git commit -m "..." && git push` → 몇 분 뒤 Pages 반영. (캐시면 Ctrl+F5)

## 하지 말 것
- 원본 `mustit_orders.orders`(관리자 전용) 접근, `AT TIME ZONE` 사용, service_role 노출, 다른 사람 대시보드 파일 임의 수정, 개인정보를 게이트 밖으로 노출.
