-- =============================================================================
-- Smart Arbitrage fingerprint: facts listed with pipes
--
-- SMMFollows writes its facts with pipes, not brackets ("Spotify Saves | Location: Hungary | Quality: High | Refill: Lifetime | MAX 1M"),
-- so the whole name was one long base and no storefront service ever matched it. Now the first part is the service and every other
-- part is a fact like a bracket; markers in front of a fact ("🌍 Location: UK") and labels ("Location:", "Quality:") are dropped, HTML
-- entities decoded. The stored donor fingerprints are rebuilt and the autopilot is asked to run again.
-- =============================================================================

create or replace function public.service_fingerprint(p_name text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v       text := lower(coalesce(p_name, ''));
  v_base  text;
  v_tags  text[] := '{}';
  v_raw   text;
  v_tag   text;
  v_refill text := 'unstated';
  v_num   integer;
  m       text[];
  v_parts text[];
begin
  -- HTML entities some panels send ("real &amp; active")
  v := replace(replace(replace(v, '&amp;', '&'), '&#039;', ''''), '&quot;', '"');
  v := translate(v, '(){}', '[][]');
  -- facts listed with pipes OUTSIDE brackets ("spotify saves | location: hungary | refill: lifetime"): the first part is the service,
  -- every other part is a fact, exactly like a bracket (pipes inside brackets are kept aside meanwhile)
  for m in select regexp_matches(v, '\[[^\]]*\]', 'g') loop
    v := replace(v, m[1], replace(m[1], '|', chr(1)));
  end loop;
  if position('|' in v) > 0 then
    v_parts := string_to_array(v, '|');
    v := v_parts[1] || coalesce((select string_agg(' [' || translate(p, '[]', '  ') || ']', '' order by i)
                                    from unnest(v_parts[2:]) with ordinality as x(p, i) where btrim(p) <> ''), '');
  end if;
  v := replace(v, chr(1), '|');
  -- decoration: country flags (the country is also written out) and the markers panels sprinkle on names
  v := regexp_replace(v, '[\U0001F1E6-\U0001F1FF️‍💧⛔♻🔥🟢🔵🔴🟡🟣🟠🟤⚫⚪⚡⏳⌛💎❌✅✔➜➡→⭐🌟✨🆕🚀🏆💯🎁📊🤖]', ' ', 'g');
  -- punctuation that is not a value separator
  v := regexp_replace(v, '[!"#$&''*;<=>?@\\^_`~]', ' ', 'g');
  for m in select regexp_matches(v, '\[([^\]]*)\]', 'g') loop
    -- one bracket can hold several facts: "[ cheap | 10-20k/day | refill : lifetime ]"
    foreach v_raw in array string_to_array(m[1], '|') loop
      v_tag := btrim(regexp_replace(v_raw, '\s+', ' ', 'g'));
      -- a marker in front of words is decoration ("🌍 location: uk", "⬆️ max: 1m"); a tag that is only an emoji (a reaction) stays
      v_tag := regexp_replace(v_tag, '^[^[:alnum:]]+(?=[[:alnum:]])', '');
      -- a label is not part of the value: "location: uk" -> "uk", "quality: high" -> "high"
      v_tag := regexp_replace(v_tag, '^(location|country|countries|geo|targeting|target|quality|type)\s*:\s*', '');
      continue when v_tag = '';
      -- how and how fast it is delivered, not what is delivered
      continue when v_tag ~ '^(max|min|start|starts|start time|speed|time|delivery|drip|drip-feed|server|day speed|per day|\d[\d.,k+ -]*/\s*(d|day|days|h|hr|hour|hours))\M';
      if v_tag ~ '(refill|guarantee|guaranteed|garanty|warranty)' or v_tag ~ '^r\d+$' then
        if v_tag ~ 'no ?drop|low ?drop|non ?drop' then
          v_refill := 'unknown';
        elsif v_tag ~ '(\mno\M|\mnon\M|without|\m0 ?(d|days?)\M)' then
          v_refill := '0';
        elsif v_tag ~ '(lifetime|life time|forever|permanent)' then
          v_refill := 'life';
        elsif v_tag ~ '\d' then
          v_num := substring(v_tag from '(\d+)')::integer;
          v_refill := case
            when v_tag ~ '\d+ ?(y|yr|year|years)\M' then (v_num * 365)::text
            when v_tag ~ '\d+ ?(m|mo|month|months)\M' then (v_num * 30)::text
            else v_num::text end;
        else
          v_refill := 'unknown';
        end if;
        continue;
      end if;
      v_tags := v_tags || v_tag;
    end loop;
  end loop;
  -- the base: words only (any emoji outside the brackets is decoration)
  v_base := regexp_replace(v, '\[[^\]]*\]', ' ', 'g');
  v_base := btrim(regexp_replace(regexp_replace(v_base, '[^[:alnum:][:space:]+/.-]', ' ', 'g'), '\s+', ' ', 'g'));
  return jsonb_build_object(
    'base', v_base,
    'tags', coalesce((select string_agg(t, ',' order by t) from unnest(v_tags) t), ''),
    'refill', v_refill);
end;
$$;

update public.provider_services ps
   set fp_base = f ->> 'base', fp_tags = f ->> 'tags', fp_refill = f ->> 'refill'
  from (select id, public.service_fingerprint(name) f from public.provider_services) x
 where x.id = ps.id
   and (ps.fp_base, ps.fp_tags, ps.fp_refill) is distinct from (x.f ->> 'base', x.f ->> 'tags', x.f ->> 'refill');

update public.arbitrage_state set requested_at = now() where id = 1;
