-- Per-user daily AI usage caps (public/multi-tenant build).
--
-- A generic counter keyed by (user, PT calendar day, action). The first cap it
-- enforces is the "Coach Score" (AI trade grade) at 3 "Grade with AI" clicks
-- per day, but the same table + RPC serve any AI route (12 exist) so caps are
-- one-line to add later.
--
-- Reset is implicit: the PT date is part of the key, so a new day is a fresh
-- row (count 0). Run in the Supabase SQL editor. Idempotent.

create table if not exists public.ai_usage (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  usage_date  date not null,          -- PT calendar day (America/Los_Angeles)
  action      text not null,          -- e.g. 'coach_score'
  count       int  not null default 0,
  updated_at  timestamptz not null default now(),
  unique (user_id, usage_date, action)
);

create index if not exists ai_usage_user_day_idx on public.ai_usage(user_id, usage_date);

alter table public.ai_usage enable row level security;
drop policy if exists "Owner ai_usage" on public.ai_usage;
create policy "Owner ai_usage" on public.ai_usage
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Atomic check-and-increment. Returns whether the action is allowed (under the
-- limit) and the resulting used-count. A row lock (the upsert + the implicit
-- serialization on the unique key) makes two simultaneous clicks safe: the
-- second sees the first's increment. SECURITY DEFINER so it can write the row
-- regardless of the caller's RLS, but it only ever touches auth.uid()'s own row.
create or replace function public.consume_ai_usage(p_action text, p_limit int)
returns table(allowed boolean, used int, day date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_date date := (now() at time zone 'America/Los_Angeles')::date;
  v_count int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.ai_usage (user_id, usage_date, action, count)
  values (v_uid, v_date, p_action, 0)
  on conflict (user_id, usage_date, action) do nothing;

  select ai_usage.count into v_count
  from public.ai_usage
  where user_id = v_uid and usage_date = v_date and action = p_action
  for update;

  if v_count >= p_limit then
    return query select false, v_count, v_date;
  else
    update public.ai_usage
      set count = ai_usage.count + 1, updated_at = now()
    where user_id = v_uid and usage_date = v_date and action = p_action;
    return query select true, v_count + 1, v_date;
  end if;
end $$;

grant execute on function public.consume_ai_usage(text, int) to authenticated;
