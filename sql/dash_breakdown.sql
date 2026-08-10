-- dash_breakdown — 차원별(브랜드/카테고리/…) 집계 RPC
-- 사용처: dashboards/d-msmr6ejlxyw.html (브랜드 TOP N 막대 · 카테고리 비중 도넛)
-- 실행: Supabase → SQL Editor 에 전체 붙여넣고 Run (관리자 1회)
--
-- 규칙 준수
--  · 일시는 이미 KST → AT TIME ZONE 사용하지 않음 (order_datetime 그대로, 기간 인덱스 사용)
--  · anon 에는 권한 주지 않고 authenticated + _dash_guard() 검사
--  · 반환은 집계값만 (개인정보 컬럼은 차원으로 허용하지 않음)
--
-- 입력  p       : { from:'YYYY-MM-DD', to:'YYYY-MM-DD', filters:{ 컬럼:[값…] }, product_name:'…' }
--       p_dim   : 집계 차원 컬럼명 (아래 v_dims 화이트리스트)
--       p_limit : 상위 N개 (1~200, 기본 20)
-- 반환  { dim, rows:[{k,tp,gross,net_rev,net_profit,qty,orders}…], total:{tp,gross,net_rev,net_profit,qty,groups} }
--       rows 는 거래액(tp) 내림차순 상위 N개, total 은 필터 전체 합계(상위 N 밖 포함) → 비중 계산·'기타' 산출용

create or replace function public.dash_breakdown(
  p jsonb,
  p_dim text default 'brand',
  p_limit int default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- 집계 차원 허용목록 (개인정보 컬럼 제외)
  v_dims text[] := array[
    'brand','category_gender','category_l','category_m','category_s',
    'order_type','order_status','product_division','payment_method','platform',
    'member_grade','customer_type','seller_grade','seller_id','ship_origin',
    'courier','naver_discount_applied','product_condition'
  ];
  -- 필터 허용목록 (Master 필터바와 동일)
  v_filters text[] := array[
    'brand','category_gender','category_l','order_status','order_type',
    'product_division','payment_method','platform','member_grade','age_band',
    'buyer_gender','region_sido','customer_type','seller_id','seller_grade',
    'join_year','ship_origin','naver_discount_applied'
  ];
  v_dim   text;
  v_from  date := nullif(p->>'from','')::date;
  v_to    date := nullif(p->>'to','')::date;
  v_pn    text := nullif(p->>'product_name','');
  v_limit int  := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_where text;
  v_key   text;
  v_vals  text[];
  v_sql   text;
  v_out   jsonb;
begin
  -- 허용목록 검사 (기존 dash_* RPC 와 동일한 가드)
  -- ※ _dash_guard() 가 boolean 을 반환하며 예외를 던지지 않는 구현이면 아래 한 줄을 다음으로 바꿀 것:
  --    if not public._dash_guard() then raise exception 'unauthorized' using errcode = '42501'; end if;
  perform public._dash_guard();

  v_dim := lower(coalesce(p_dim, 'brand'));
  if not (v_dim = any (v_dims)) then
    raise exception 'dash_breakdown: 허용되지 않은 집계 차원 %', p_dim using errcode = '22023';
  end if;
  if v_from is null or v_to is null then
    raise exception 'dash_breakdown: from/to 는 필수입니다' using errcode = '22023';
  end if;

  -- 기간: order_datetime 은 이미 KST. [from 00:00, to+1일 00:00) 반개구간 → 인덱스 사용
  v_where := format(
    ' where o.order_datetime >= %L::timestamp and o.order_datetime < (%L::date + 1)::timestamp',
    v_from, v_to
  );

  if v_pn is not null then
    v_where := v_where || format(' and o.product_name ilike %L', '%' || v_pn || '%');
  end if;

  for v_key in select k from jsonb_object_keys(coalesce(p->'filters', '{}'::jsonb)) k loop
    if not (v_key = any (v_filters)) then
      continue;                                  -- 알 수 없는 필터 키는 무시
    end if;
    v_vals := array(select jsonb_array_elements_text(p->'filters'->v_key));
    if coalesce(array_length(v_vals, 1), 0) = 0 then
      continue;
    end if;
    v_where := v_where || format(' and o.%I::text = any (%L::text[])', v_key, v_vals);
  end loop;

  v_sql := format($q$
    with base as (
      select coalesce(nullif(o.%1$I::text, ''), '(미지정)') as k,
             sum(coalesce(o.total_purchase, 0)) as tp,
             sum(coalesce(o.gross_revenue,  0)) as gross,
             sum(coalesce(o.net_revenue,    0)) as net_rev,
             sum(coalesce(o.net_profit,     0)) as net_profit,
             sum(coalesce(o.quantity,       0)) as qty,
             count(distinct o.order_no)         as orders
        from mustit_orders.orders_v o
        %2$s
       group by 1
    ),
    top as (
      select * from base order by tp desc nulls last, k limit %3$s
    ),
    tot as (
      select coalesce(sum(tp), 0)         as tp,
             coalesce(sum(gross), 0)      as gross,
             coalesce(sum(net_rev), 0)    as net_rev,
             coalesce(sum(net_profit), 0) as net_profit,
             coalesce(sum(qty), 0)        as qty,
             count(*)                     as groups
        from base
    )
    select jsonb_build_object(
      'dim',   %4$L::text,
      'rows',  coalesce((select jsonb_agg(to_jsonb(t) order by t.tp desc) from top t), '[]'::jsonb),
      'total', (select to_jsonb(x) from tot x)
    )
  $q$, v_dim, v_where, v_limit, v_dim);

  execute v_sql into v_out;
  return v_out;
end
$fn$;

-- 권한: anon 금지, 로그인 사용자만
revoke all on function public.dash_breakdown(jsonb, text, int) from public;
revoke all on function public.dash_breakdown(jsonb, text, int) from anon;
grant execute on function public.dash_breakdown(jsonb, text, int) to authenticated;

-- 확인용
-- select public.dash_breakdown('{"from":"2026-07-01","to":"2026-07-31","filters":{}}'::jsonb, 'brand', 10);
