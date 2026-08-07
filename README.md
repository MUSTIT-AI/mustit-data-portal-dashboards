# MUST IT 데이터 대시보드

브라우저가 **서울 Supabase의 집계 API(RPC)를 직접 조회**하는 정적 대시보드 모음.
서버·빌드 없음, GitHub Pages로 배포. push하면 자동 반영.

- **URL:** https://mustit-ai.github.io/mustit-data-portal-dashboards/
- **데이터:** Supabase(서울) · KST 기준 · 매일 08:00 갱신
- **개인정보:** 집계 API가 **개인정보(구매자·회원번호·연령·성별·지역)를 원천 제외**하므로 게이트 없이 공개해도 노출되지 않음.

## 구조

```
index.html                         ← 랜딩(대시보드 목록)
dashboards/
  전체주문_주문일_Master.html        ← QuickSight 마스터뷰 재현 (ECharts)
```

**대시보드 1개 = HTML 파일 1개.** `dashboards/`에 `.html`을 추가하고 push하면 됩니다. 파일이 달라 여러 명이 동시에 만들어도 충돌 없음.

## 데이터 가져오기 — 집계 RPC 직접 호출

브라우저에서 publishable 키로 `POST /rest/v1/rpc/<함수>` 를 호출합니다. (키는 공개용, 권한은 RPC가 제한)

```js
const SB  = "https://hhvmhtejmhhxksnldfmi.supabase.co";
const KEY = "sb_publishable_3qHI5hEv90wiU03q3mmS4Q_nUdAovOw";
async function rpc(fn, body){
  const r = await fetch(SB+"/rest/v1/rpc/"+fn, {
    method:"POST",
    headers:{apikey:KEY, Authorization:"Bearer "+KEY, "Content-Type":"application/json"},
    body: JSON.stringify(body||{})
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
// 예: 기간 필터로 KPI 요약
const p = { from:"2026-07-01", to:"2026-08-06", filters:{ brand:["Moncler"] } };
const kpi = await rpc("dash_summary", { p });
```

### 제공 RPC (모두 집계·비PII, `anon` 실행 허용)
| 함수 | 반환 |
|------|------|
| `dash_summary(p jsonb)` | KPI 12종(구매수량·총구매금액·총매출·자사할인·순매출·순이익·수수료율·순이익율·배송기간 등) |
| `dash_daily(p jsonb)` | 일별 시계열(거래액·주문수·구매수량·할인·순매출·순이익·적립금 등) |
| `dash_coupon(p jsonb)` | 쿠폰별 일별 추이(item/member/cps) |
| `dash_raw(p jsonb, p_limit int)` | RAW 주문라인 (비PII 컬럼만, 최근순) |
| `dash_filters()` | 필터 드롭다운 옵션 |

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
- 게이트 없이 공개되나, **RPC가 집계·비PII만 반환**하고 원본 뷰(`orders_v`)·PII 컬럼은 `anon` 접근 차단됨.
- 임의 SQL RPC(`dash_query`)와 `anon`의 원본 뷰 직접권한은 **보안상 회수(비활성)** 됨.
  → 구버전 서버 방식(`server.js` + 비밀번호 게이트 + `dashQuery(SQL)`)과 `dashboards/월별매출.html`(샘플)은 더 이상 동작하지 않음. 새 대시보드는 위의 **RPC 직접 호출** 방식을 쓸 것.
