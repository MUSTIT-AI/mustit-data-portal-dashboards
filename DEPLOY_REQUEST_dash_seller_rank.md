# 배포 요청: RPC 1개 (판매자별 매출 현황 대시보드)

## 왜 필요한가

`dashboards/d-mt2nttxtrgu.html`("[주문] 판매자별 매출 현황")는 선택한 기간의 판매자ID별 거래액(GMV)·순매출·순이익·주문수 등을 보여줍니다.
CLAUDE.md 규칙상 이런 "집계가 목적"인 화면은 `dash_raw`로 원본 주문 라인을 브라우저에 당겨서 접으면 안 되고(기간이 길면 타임아웃·트래픽 문제), `dash_product_rank`(상품 랭킹)와 같은 패턴으로 **DB에서 판매자 단위로 GROUP BY 해서 반환하는 RPC**가 필요합니다. 이 RPC(`dash_seller_rank`)는 아직 DB에 없습니다(`PGRST202`로 없음 확인됨).

이 작업 세션에는 Supabase에 DDL을 실행할 자격 증명(service_role/`SUPABASE_ACCESS_TOKEN`/DB 비밀번호)이 없어서, 아래 SQL을 대신 실행해 주셔야 대시보드가 실제 데이터로 동작합니다. 파일 자체는 이미 push 가능한 상태고, RPC가 배포되기 전까지는 "오류: Could not find the function..." 메시지가 뜹니다.

## 배포해야 할 것

Supabase SQL Editor(https://supabase.com/dashboard/project/hhvmhtejmhhxksnldfmi/sql/new)에서 아래 SQL 실행:

```sql
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
```

- `anon`에는 grant하지 않습니다(CLAUDE.md 보안 규칙).
- 날짜는 CLAUDE.md 규칙대로 `AT TIME ZONE` 없이 `order_datetime`(이미 KST) 그대로 비교합니다.
- 필터는 화이트리스트 원칙에 따라 지금은 `order_status`만 반영했습니다(대시보드가 실제로 쓰는 필터). 다른 컬럼 필터가 필요해지면 같은 패턴으로 추가하면 됩니다.
- `orders_secure`의 실제 컬럼명(`seller_id`/`order_no`/`quantity`/`total_purchase`/`net_revenue`/`net_profit`/`own_discount_ttl`/`order_status`/`order_datetime`)은 CLAUDE.md·`all-orders-master.html`의 RAW_COLS 기준이니, 실제 스키마가 다르면 맞춰 수정해 주세요.
- 배포 후 확인: 대시보드 새로고침(Ctrl+F5) → "판매자별 매출 현황" 차트·표에 값이 채워지면 완료.

## 배포 방법

1. 위 SQL Editor 링크로 이동
2. 위 SQL 붙여넣고 Run
3. 에러 없이 성공하면 끝 (별도 CLI/배포 불필요 — RPC는 즉시 반영됨)
