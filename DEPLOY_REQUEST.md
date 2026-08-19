# 배포 요청: Edge Function 2개 (상품 랭킹 대시보드)

## 왜 필요한가

상품 랭킹 대시보드(`dashboards/d-msmrgs2xane.html`)에 **상품 이미지**와 **최대혜택가** 컬럼을 추가했는데, 이 두 값은 이 사이트가 원래 쓰는 방식(브라우저 → Supabase RPC/뷰 직접 호출)으로는 가져올 수 없어요.

- **왜 RPC/뷰로 안 되나**: 이미지·최대혜택가는 머스트잇 Open API(`api.mustit.co.kr`)의 실시간 값이에요. 이 API는 `client_secret` + 비밀번호로 2단계 인증하는 **진짜 비밀키**가 필요해서, 정적 사이트인 이 레포의 브라우저 JS에 직접 넣으면 로그인한 사람 누구나 개발자도구로 키를 볼 수 있어요 → 보안상 절대 안 됨.
- **매일 동기화되는 공개 뷰(`mustit_products`/`mustit_catalogs`)로 먼저 시도했었는데** 실측해보니 오래된 카탈로그(예: 2025-12 생성분)를 백필 안 해서 다수 상품의 이미지가 누락됐어요(54건 중 0건 매칭 확인). 최대혜택가는 애초에 이 동기화 뷰에 값 자체가 없음(실시간 전용 필드).
- **그래서**: 비밀키는 서버(Supabase Edge Function)에만 두고, 브라우저는 그 함수만 호출해서 값만 받는 구조로 만들었어요. `openapi-orders` 함수(실시간 주문 대시보드용)가 이미 같은 패턴으로 같은 API를 쓰고 있어서, 이번 것도 같은 방식이에요.

## 배포해야 할 것

| 함수 이름 | 코드 위치 | 하는 일 |
|---|---|---|
| `product-images` | `supabase/functions/product-images/index.ts` | 상품번호(최대 500개) 받아서 → 이미지 URL 반환 |
| `product-price` | `supabase/functions/product-price/index.ts` | 상품번호(최대 500개) 받아서 → 최대혜택가 반환 |

두 함수 모두:
- 로그인한 사용자만 호출 가능(Supabase 플랫폼이 기본으로 강제)
- 비밀키(`MUSTIT_CLIENT_ID`, `MUSTIT_CLIENT_SECRET`, `OPENAPI_USERNAME`, `OPENAPI_PASSWORD`)는 Supabase 시크릿에서 읽음 — `openapi-orders`가 이미 쓰고 있다면 새로 등록 안 해도 될 가능성 높음(`supabase secrets list`로 확인 가능)

## 배포 방법 (둘 중 하나)

**A. CLI**
```bash
npx supabase login
npx supabase functions deploy product-images --project-ref hhvmhtejmhhxksnldfmi
npx supabase functions deploy product-price --project-ref hhvmhtejmhhxksnldfmi
```

**B. Supabase 대시보드에서 직접** (CLI 불필요)
1. https://supabase.com/dashboard/project/hhvmhtejmhhxksnldfmi/functions
2. "Deploy a new function" → 이름 `product-images` → 위 파일 내용 붙여넣고 배포
3. 같은 방식으로 `product-price`도 배포

배포 끝나면 대시보드 새로고침(Ctrl+F5)으로 바로 확인 가능해요.
