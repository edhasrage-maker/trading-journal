-- ============================================================================
-- Share links: return the owner's chart drawings with the day (Pt 20)
-- ============================================================================
-- Drawings (zones, text, levels the trader drew by hand) never reached anyone
-- opening a /share/<token> link. get_shared_day() returned day/trades/
-- market_context/chart_prefs only, and LiveChart fetched annotations itself
-- from /api/annotations?date= — a request resolved under the CALLER's RLS. So
-- the owner opening their own link saw their drawings (they're logged in) and
-- every recipient got an empty list. That made the bug invisible from the one
-- browser most likely to check it.
--
-- Fix: hand the drawings out through the same token-gated SECURITY DEFINER
-- door as everything else on the page, scoped to the share's owner.
--
-- Idempotent: create or replace. Safe to re-run.
create or replace function public.get_shared_day(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_id uuid;
  v_owner  uuid;
begin
  select trading_day_id, user_id into v_day_id, v_owner
  from public.shares
  where token = p_token
    and not revoked
    and (expires_at is null or expires_at > now());
  if v_day_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'day', (select to_jsonb(td) from public.trading_days td where td.id = v_day_id),
    'trades', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.entry_time), '[]'::jsonb)
      from public.trades t where t.trading_day_id = v_day_id
    ),
    'market_context', (
      select to_jsonb(mc) from public.market_context mc where mc.trading_day_id = v_day_id
    ),
    -- Owner's chart appearance prefs so the shared chart shows THEIR colors.
    'chart_prefs', (
      select value from public.chart_prefs
      where user_id = v_owner and key = 'livechart-prefs-v2' limit 1
    ),
    -- Owner's drawings for this day. user_id is redundant with the day scope
    -- (a day belongs to one user) but stated anyway: this function runs as the
    -- table owner with RLS bypassed, so the WHERE clause IS the tenancy check.
    'annotations', (
      select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]'::jsonb)
      from public.chart_annotations a
      where a.trading_day_id = v_day_id and a.user_id = v_owner
    )
  );
end $$;

grant execute on function public.get_shared_day(uuid) to anon, authenticated;
