# 배포 요청: RPC 1개 (판매자별 등록 상품수 대시보드)

## 왜 필요한가

새 대시보드 `dashboards/d-mt2nttxtrgu.html`("[상품] 판매자별 등록 상품수")는 판매자ID별 **등록 상품수**(전체/판매중/판매중지)를 보여줍니다.
데이터 원본은 `mustit_products`(Open API 상품 마스터, ~340만 행)인데, CLAUDE.md 규칙상 **이만한 원본을 브라우저로 당겨서 집계하면 안 됩니다**(트래픽·속도 문제). 그래서 브랜드별 집계(`mustit_products_by_brand`)와 같은 패턴으로 **판매자별 집계 RPC**가 필요한데, 이 RPC는 아직 DB에 없습니다(`mustit_products_by_seller` 호출 시 `PGRST202`로 없음 확인됨).

이 작업 세션에는 Supabase에 DDL을 실행할 수 있는 자격 증명(서비스 롤 키·`SUPABASE_ACCESS_TOKEN`·DB 비밀번호)이 없어서, 아래 SQL을 대신 실행해 주셔야 대시보드가 실제 데이터로 동작합니다. (파일 자체는 이미 만들어서 push 가능한 상태입니다 — RPC가 배포되기 전까지는 대시보드에 "오류: Could not find the function..." 메시지가 뜹니다.)

## 배포해야 할 것

Supabase SQL Editor(https://supabase.com/dashboard/project/hhvmhtejmhhxksnldfmi/sql/new)에서 아래 SQL 실행:

```sql
create or replace function public.mustit_products_by_seller(p_limit integer default 20000)
returns table(
  seller_id text,
  product_count bigint,
  active_count bigint,
  avg_price numeric
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 기존 RPC(dash_summary 등)와 동일하게 allowlist 검사를 통과해야 실행되도록 함.
  -- _dash_guard()의 실제 시그니처가 다르면(예: 파라미터 필요) 기존 RPC 정의를 참고해 맞춰주세요.
  perform public._dash_guard();

  return query
    select
      p.seller_id,
      count(*)::bigint as product_count,
      count(*) filter (where p.product_status = 'IN_STOCK')::bigint as active_count,
      avg(p.selling_price)::numeric as avg_price
    from mustit_api.mustit_products p
    where p.seller_id is not null
    group by p.seller_id
    order by product_count desc
    limit p_limit;
end;
$$;

grant execute on function public.mustit_products_by_seller(integer) to authenticated;
```

- `anon`에는 grant하지 않습니다(CLAUDE.md 보안 규칙).
- `mustit_api.mustit_products`의 실제 스키마(컬럼명 `seller_id`/`product_status`/`selling_price`)는 CLAUDE.md 문서 기준이니, 실제 컬럼명이 다르면 맞춰 수정해 주세요.
- 배포 후 확인: 대시보드 새로고침(Ctrl+F5) → "판매자별 등록 상품수" 차트·표에 값이 채워지면 완료.

## 배포 방법

1. 위 SQL Editor 링크로 이동
2. 위 SQL 붙여넣고 Run
3. 에러 없이 성공하면 끝 (별도 CLI/배포 불필요 — RPC는 즉시 반영됨)
