-- 판매자별 등록 상품수 대시보드(dashboards/d-mt2nttxtrgu.html 이전 버전에서 쓰던 RPC)용.
-- 상세 배경: ../../DEPLOY_REQUEST_mustit_products_by_seller.md
-- mustit_api.mustit_products(~340만 행)를 브라우저로 당기지 않고 DB에서 판매자 단위로 집계한다.

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
