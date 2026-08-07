# MUST IT 데이터 대시보드 (직원용)

직원이 만드는 데이터 대시보드 모음. **비밀번호로 접속**하고, 데이터는 **읽기 전용**(orders_v/orders_v_kr)만 조회됩니다.

- **URL:** 배포 후 Railway URL (관리자에게 문의)
- **접속 비밀번호:** 관리자에게 문의 (Railway env `DASH_PASSWORD`)
- **데이터:** Supabase(서울) · 이 앱은 조회 결과만 전달, 원본 저장 안 함

## 새 대시보드 만들기 (제일 중요)

**대시보드 1개 = HTML 파일 1개.** `dashboards/` 폴더에 `.html` 파일을 추가하면 홈에 자동 표시됩니다. 서로 다른 파일이라 **여러 명이 동시에 만들어도 충돌 없음.**

```
dashboards/
  월별매출.html      ← 샘플 (이걸 복사해서 시작하세요)
  내대시보드.html    ← 새로 추가
```

### 데이터 가져오기 (한 줄)
HTML 안에서 `dash.js`를 불러오고 `dashQuery("SELECT ...")` 를 호출하면 행 배열이 옵니다.

```html
<script src="/dash.js"></script>
<script>
(async () => {
  const rows = await dashQuery(
    "select brand, sum(gross_revenue) rev from mustit_orders.orders_v " +
    "where order_status='정산완료' group by 1 order by rev desc limit 10"
  );
  console.log(rows); // [{brand:'...', rev: 12345}, ...]
})();
</script>
```

### 쿼리 규칙 (필독)
- **SELECT/WITH 조회만** 됩니다 (쓰기·DDL 전부 차단).
- 테이블은 **`mustit_orders.orders_v`** (영문 컬럼) 또는 **`orders_v_kr`** (한글 컬럼)만.
- **일시는 이미 KST** → `AT TIME ZONE` 쓰지 말고 그대로: `order_datetime::date`, `date_trunc('month', order_datetime)`, `extract(hour from order_datetime)`.
- 매출=`gross_revenue`(정산완료 기준), 거래액=`total_purchase`, 순이익=`net_profit`.
- 15초 넘는 쿼리는 중단됩니다 → 기간 필터로 좁히세요.

## 배포 (Claude Code 권장)
```bash
git clone https://github.com/MUSTIT-AI/mustit-data-portal-dashboards
cd mustit-data-portal-dashboards
# dashboards/ 에 HTML 추가 (Claude에게 "이런 대시보드 만들어줘")
git add -A && git commit -m "새 대시보드: xxx" && git push   # → Railway 자동배포(연결 시)
```

## 환경변수 (Railway)
| 키 | 용도 |
|----|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_ANON_KEY` | 읽기전용 조회용(공개키, 권한은 RPC가 제한) |
| `DASH_PASSWORD` | 접속 비밀번호 (게이트) |

## 보안 메모
- 공개 URL이라 **비밀번호 게이트** 필수. 데이터 조회는 `anon` 권한 RPC로 **orders_v/orders_v_kr만**, 원본 테이블·회원식별자·PIN 등은 접근 불가.
- 그래도 주문 데이터가 국외(Railway) 경유하므로, 민감 필드는 쿼리에 넣지 말 것.
