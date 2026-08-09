# MUST IT 데이터 대시보드

브라우저가 **서울 Supabase의 집계 API(RPC)를 직접 조회**하는 정적 대시보드 모음.
서버·빌드 없음, GitHub Pages로 배포. push하면 자동 반영.

- **URL:** https://mustit-ai.github.io/mustit-data-portal-dashboards/
- **데이터:** Supabase(서울) · KST 기준 · 매일 08:00 갱신
- **로그인 필수:** Supabase Auth(이메일+비밀번호). 로그인해야 화면이 열리고, 데이터 RPC도 `authenticated`+**허용목록**에 등록된 계정만 호출 가능(DB 레벨 차단).

## 로그인 · 계정 관리 (관리자)

접근 = ①Supabase Auth 계정 + ②`public.dash_allowed` 허용목록, **둘 다** 필요. 관리자는 **사이트 안에서** 직접 관리합니다.

- **사이트 내 계정 관리**: 로그인 후 홈의 **⚙️ 계정 관리**에서:
  - **계정 생성/삭제** + 계정별 **역할**(뷰어/편집자/관리자), **GitHub 아이디**, **개인정보 열람** 설정
  - **대시보드별 열람/수정 권한**(`dashboard_acl`) 지정
  - 내부적으로 Edge Function `admin-users`가 처리(service_role은 서버측에만, 호출자가 관리자인지 검증).
- **권한 강제 수준**: 개인정보 열람=DB 강제(진짜) / 대시보드 열람=페이지 레벨(같은 데이터라 API 직접호출까진 못 막음) / 대시보드 수정=관례(CLAUDE.md)+선택적 GitHub 하드락.
- **관리자 부트스트랩**(최초 1회): `admin.html`은 관리자만 열림. 아래 데모 관리자 계정으로 처음 로그인 → 본인 계정 생성(관리자 체크) → 데모 계정 삭제.
- **대시보드 관리(대안)**: Supabase → Authentication → Users → Add user + `insert into public.dash_allowed(email,note,is_admin) values (lower('x@mustit.co.kr'),'이름',false);`

**권장 보안설정**: Authentication → Sign In / Providers → Email → **"Allow new users to sign up" 끄기**. 허용목록이 이미 막지만 이중 안전.

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

## 개발 준비 (각 PC에서 처음 한 번만)

새 대시보드를 만들거나 고치려면 아래를 한 번 세팅합니다. (개발자 아니어도 순서대로 따라 하면 됩니다)

### 1. Git 설치
- **Windows:** https://git-scm.com/download/win → 받은 설치파일 실행 → **전부 기본값(Next)**으로 설치 → 설치 후 PC 재부팅 권장
  - 확인: 명령프롬프트(`cmd`)에서 `git --version` → 버전 숫자가 뜨면 성공
- **Mac:** 터미널에서 `git --version` 입력 → 안 깔려 있으면 설치 안내창이 뜸(설치 클릭). 또는 `brew install git`

### 2. GitHub 로그인 (레포 write 계정으로, 한 번)
비공개 레포라 push하려면 GitHub 인증이 필요합니다. 가장 쉬운 방법:
1. **GitHub CLI 설치:** https://cli.github.com → 받아서 기본값으로 설치
2. 터미널에서 **`gh auth login`** 실행 → `GitHub.com` → `HTTPS` → `Login with a web browser` 선택 → 뜨는 코드 입력 후 브라우저에서 로그인
   - ⚠️ **레포 write 권한이 있는 회사 GitHub 계정**으로 로그인할 것
3. 이후 `git push`가 비밀번호 없이 됩니다.

> 확인: `gh auth status` → `Logged in to github.com` 이 뜨면 완료.

### 3. (선택) Claude Code
Claude Code를 쓰면 위 준비 후 **"이 대시보드 이렇게 고치고 push해줘"** 라고만 하면 편집·커밋·배포까지 자동으로 처리합니다. GitHub MCP 같은 별도 연결은 필요 없습니다.

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
