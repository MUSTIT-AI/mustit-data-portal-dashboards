-- 판매자별 매출 현황 대시보드(dashboards/d-mt2nttxtrgu.html)용.
-- 상세 배경: ../../DEPLOY_REQUEST_dash_seller_rank.md
-- orders_secure 원본을 브라우저로 당기지 않고 DB에서 판매자 단위로 GROUP BY 해서 반환한다
-- (dash_product_rank와 동일한 패턴).

create or replace function public.dash_seller_rank(p jsonb, p_limit integer default 20000)
returns table(
  seller_id text,
  orders bigint,
  quantity bigint,
  gmv numeric,
  net_revenue numeric,
  net_profit numeric,
  own_discount numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from date := (p->>'from')::date;
  v_to   date := (p->>'to')::date;
  v_status text[];
begin
  -- 기존 RPC(dash_summary/dash_product_rank 등)와 동일하게 allowlist 검사를 통과해야 실행되도록 함.
  -- _dash_guard()의 실제 시그니처가 다르면(예: 파라미터 필요) 기존 RPC 정의를 참고해 맞춰주세요.
  perform public._dash_guard();

  if p ? 'filters' and p->'filters' ? 'order_status' then
    select array_agg(x) into v_status from jsonb_array_elements_text(p->'filters'->'order_status') x;
  end if;

  return query
    select
      o.seller_id,
      count(distinct o.order_no)::bigint as orders,
      sum(o.quantity)::bigint as quantity,
      sum(o.total_purchase)::numeric as gmv,
      sum(o.net_revenue)::numeric as net_revenue,
      sum(o.net_profit)::numeric as net_profit,
      sum(o.own_discount_ttl)::numeric as own_discount
    from public.orders_secure o
    where o.order_datetime >= v_from
      and o.order_datetime <  (v_to + 1)
      and (v_status is null or o.order_status = any(v_status))
      and o.seller_id is not null
    group by o.seller_id
    order by gmv desc
    limit p_limit;
end;
$$;

grant execute on function public.dash_seller_rank(jsonb, integer) to authenticated;
