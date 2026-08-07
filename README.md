# MUST IT 데이터 대시보드

브라우저가 **서울 Supabase의 집계 API(RPC)를 직접 조회**하는 정적 대시보드 모음.
서버·빌드 없음, GitHub Pages로 배포. push하면 자동 반영.

- **URL:** https://mustit-ai.github.io/mustit-data-portal-dashboards/
- **데이터:** Supabase(서울) · KST 기준 · 매일 08:00 갱신
- **로그인 필수:** Supabase Auth(이메일+비밀번호). 로그인해야 화면이 열리고, 데이터 RPC도 `authenticated`+**허용목록**에 등록된 계정만 호출 가능(DB 레벨 차단).

## 로그인 · 계정 관리 (관리자)

접근 = ①Supabase Auth 계정 존재 + ②`public.dash_allowed` 허용목록 등록, **둘 다** 필요.

**계정 추가**
1. Supabase 대시보드 → Authentication → Users → **Add user** (이메일·비밀번호, Auto Confirm 켜기)
2. SQL Editor에서 허용목록 등록:
   ```sql
   insert into public.dash_allowed(email, note)
   values (lower('someone@mustit.co.kr'), '담당자') on conflict do nothing;
   ```
**계정 제거**: Authentication에서 유저 삭제 + `delete from public.dash_allowed where email = lower('someone@mustit.co.kr');`

**권장 보안설정**: Authentication → Sign In / Providers → Email → **"Allow new users to sign up" 끄기**(공개 자가가입 차단). 허용목록이 이미 막지만 이중 안전.

## 구조

```
index.html                         ← 랜딩(대시보드 목록)
dashboards/
  전체주문_주문일_Master.html        ← QuickSight 마스터뷰 재현 (ECharts)
```

**대시보드 1개 = HTML 파일 1개.** `dashboards/`에 `.html`을 추가하고 push하면 됩니다. 파일이 달라 여러 명이 동시에 만들어도 충돌 없음.

## 데이터 가져오기 — 집계 RPC 직접 호출

브라우저에서 publishable 키로 `POST /rest/v1/rpc/<함수>` 를 호출합니다. (키는 공개용, 권한은 RPC가 제한)

페이지 `<head>`에 supabase-js + `auth.js`(공통 로그인 게이트)를 넣으면 `window.MUSTIT` 가 생깁니다.
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="../auth.js"></script>   <!-- dashboards/ 안에서는 ../auth.js, 루트는 auth.js -->
```
```js
// 로그인 완료 후에만 실행됨. MUSTIT.rpc 가 인증 토큰을 자동으로 붙임.
window.MUSTIT.ready(async function(){
  const p = { from:"2026-07-01", to:"2026-08-06", filters:{ brand:["Moncler"] } };
  const kpi = await window.MUSTIT.rpc("dash_summary", { p });
  // ... 렌더링 ...
});
```

### 제공 RPC (모두 집계·비PII, `anon` 실행 허용)
| 함수 | 반환 |
|------|------|
| `dash_summary(p jsonb)` | KPI 12종(구매수량·총구매금액·총매출·자사할인·순매출·순이익·수수료율·순이익율·배송기간 등) |
| `dash_daily(p jsonb)` | 일별 시계열(거래액·주문수·구매수량·할인·순매출·순이익·적립금 등) |
| `dash_coupon(p jsonb)` | 쿠폰별 일별 추이(item/member/cps) |
| `dash_raw(p jsonb, p_limit int)` | RAW 주문라인 — 개인정보 제외 89컬럼 (②탭 seq 순서) |
| `dash_raw_all(p jsonb, p_limit int)` | RAW 전체 99컬럼(개인정보 포함) — 로그인 사용자 전용 |
| `dash_filters()` | 필터 드롭다운 옵션 |

모든 RPC는 `authenticated`+허용목록(`_dash_guard`) 검사를 통과해야 실행됩니다.

### RAW 개인정보 컬럼
- RAW 기본은 **89컬럼(개인정보 제외)**. 대시보드 RAW 우측 **🔓 개인정보 포함 전체** 버튼으로 **99컬럼**(연령대·성별·회원번호·구매자ID·지역·나이·가입일 등) 토글.
- 사이트 자체가 로그인 게이트라, 로그인=인가로 보고 전체 컬럼은 별도 비밀번호 없이 열림(`dash_raw_all`).

`p` 필터 객체: `{ from, to, filters:{ 컬럼:[값…] }, product_name }`
필터 컬럼: `brand, category_gender, category_l, order_status, order_type, product_division, payment_method, platform, member_grade, age_band, buyer_gender, region_sido, customer_type, seller_id, seller_grade, join_year, ship_origin, naver_discount_applied`

### 규칙 (필독)
- **일시는 이미 KST** — `AT TIME ZONE` 금지. RPC 내부에서 `order_datetime` 그대로 사용.
- 기간 필터(`from`/`to`, order_datetime)는 **인덱스**를 타 빠름. 항상 기간을 좁혀 조회.
- 매출=`gross_revenue`(총매출), 거래액/GMV=`total_purchase`, **순매출=총매출−자사할인**, **순이익=순매출−결제수수료**.
- 마스터뷰 KPI는 **전체 주문상태** 기준(취소·반품 포함). 정산완료만 보려면 `filters.order_status:["정산완료"]`.

## 배포
```bash
git clone https://github.com/MUSTIT-AI/mustit-data-portal-dashboards
cd mustit-data-portal-dashboards
# dashboards/ 에 HTML 추가/수정 (Claude에게 "이런 대시보드 만들어줘")
git add -A && git commit -m "새 대시보드: xxx" && git push   # → GitHub Pages 자동배포
```

## 보안 메모
- **로그인(Supabase Auth) 필수** + **허용목록(`public.dash_allowed`)** 검사 → 관리자가 등록한 계정만 데이터 조회. 로그인 안 하거나 미등록 계정은 데이터 RPC가 DB에서 거부됨.
- `anon`은 모든 데이터 RPC에서 회수됨. 원본 뷰(`orders_v`)·PII 직접권한, 임의 SQL RPC(`dash_query`)도 회수(비활성).
- 데이터는 브라우저↔서울 Supabase 직결(정적 호스팅은 데이터 미경유) → 지역 규칙 충족.
- 구버전 서버 방식(`server.js`+`dashQuery`)·`dashboards/월별매출.html`(샘플)은 비동작(레거시).
- 권장: Supabase에서 **자가 회원가입(signup) 끄기**(위 로그인·계정 관리 참고).
