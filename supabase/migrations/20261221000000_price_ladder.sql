-- =============================================================================
-- The price ladder of a card: what each quantity pays per 1000, also where another offer takes over
--
-- Since 20261220000000 an order is priced on the offer that serves its quantity. A card whose small orders go through a dearer retail offer
-- (Telegram Members, Russia: 10..249 at $4.90 per 1000) gets far cheaper from the quantity where its cheapest offer starts (250: $1.19). The
-- order form lists the bulk prices of the quote (volume_rates); built from the one offer of the typed quantity, that list missed the
-- switch, so a customer typing 100 never saw "from 250 · $1.19".
--
-- price_ladder(p_segments): quote-order passes which offer serves which quantity range of the card ([{from, to, rate_per_1000,
-- basis_per_1000}], the same router as place-order, order-pricing.ts priceLadder); the answer is the rate per 1000 from the start of each
-- range and from each volume step inside it (volume_rate on that offer's cost, never under its cost + the minimum margin), in the shape of
-- calculate_order_price's volume_rates.
--
-- Also (no SQL here): sync-catalog no longer raises a card's maximum quantity for an offer more than 30% dearer than its cheapest one
-- (service-cost.ts MAX_LIMIT_COST_SPREAD), so the price never jumps several times above the card's own at the top of the range.
-- =============================================================================

create or replace function public.price_ladder(p_segments jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tiers  jsonb;
  v_margin numeric(14,4);
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' then
    raise exception 'invalid_parameter_value: segments must be an array' using errcode = 'invalid_parameter_value';
  end if;
  select volume_margin_tiers, discount_min_margin_per_1000 into v_tiers, v_margin from platform_settings where id = 1;
  return coalesce((
    with seg as (
      select (s->>'from')::integer f, (s->>'to')::integer t, (s->>'rate_per_1000')::numeric r, (s->>'basis_per_1000')::numeric b
        from jsonb_array_elements(p_segments) s
    ), pts as (
      select f as q, r, b from seg
      union all
      select (x->>'min')::integer, r, b
        from seg, jsonb_array_elements(coalesce(v_tiers, '[]'::jsonb)) x
       where (x->>'min')::integer > f and (x->>'min')::integer <= t
    )
    select jsonb_agg(jsonb_build_object(
             'min_quantity', q,
             'rate_per_1000', greatest(volume_rate(r, q, v_tiers, b), ceil((b + coalesce(v_margin, 0)) * 10000) / 10000))
           order by q)
      from pts
     where r > 0 and b >= 0), '[]'::jsonb);
end;
$$;

revoke all on function public.price_ladder(jsonb) from public, anon, authenticated;
grant execute on function public.price_ladder(jsonb) to service_role;
