-- Applied to Supabase project fnopntlihakgrydvwdge as migration "page_views" (20261112120000).
-- Privacy-friendly first-party page-view log. No IPs, emails, or raw user-agent strings.
-- Anon/authenticated may INSERT only. Owner reads via admin_visitor_stats() (same
-- private.app_admins check as admin_recent_signups). is_owner and signed_in are
-- set server-side from the JWT, not trusted from the client.

create table public.page_views (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  visitor_id uuid not null,
  path text not null,
  tab text,
  referrer_domain text,
  device text not null,
  signed_in boolean not null default false,
  is_owner boolean not null default false,
  constraint page_views_path_len check (char_length(path) between 1 and 200),
  constraint page_views_path_shape check (path like '/%' and path !~ E'[\\r\\n]'),
  constraint page_views_tab_ok check (
    tab is null or (char_length(tab) between 1 and 40 and tab ~ '^[a-z0-9_-]+$')
  ),
  constraint page_views_ref_ok check (
    referrer_domain is null
    or (char_length(referrer_domain) between 1 and 253 and referrer_domain ~ '^[A-Za-z0-9.-]+$')
  ),
  constraint page_views_device_ok check (device in ('mobile', 'tablet', 'desktop'))
);

comment on table public.page_views is
  'Anonymous first-party page views. No IP, email, or raw user-agent. Public INSERT only; owner stats via admin_visitor_stats.';
comment on column public.page_views.visitor_id is 'Random anonymous id from the browser (localStorage). Not an account id.';
comment on column public.page_views.referrer_domain is 'Referrer hostname only; same-site and empty referrers are stored as null.';
comment on column public.page_views.device is 'mobile, tablet, or desktop from viewport width. Not a user-agent string.';
comment on column public.page_views.signed_in is 'Set by trigger from auth.uid(); clients cannot spoof this.';
comment on column public.page_views.is_owner is 'Set by trigger when auth.uid() is in private.app_admins; clients cannot spoof this.';

create index page_views_created_at_idx on public.page_views (created_at);
create index page_views_created_owner_idx on public.page_views (created_at, is_owner);

-- Flags and timestamps come from the server, never the client payload.
create or replace function private.page_views_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.id := coalesce(new.id, gen_random_uuid());
  new.created_at := now();
  new.signed_in := (auth.uid() is not null);
  new.is_owner := (
    auth.uid() is not null
    and exists (select 1 from private.app_admins a where a.user_id = auth.uid())
  );
  return new;
end;
$$;

revoke all on function private.page_views_before_insert() from public, anon, authenticated;

create trigger page_views_before_insert
  before insert on public.page_views
  for each row execute function private.page_views_before_insert();

alter table public.page_views enable row level security;
alter table public.page_views force row level security;

revoke all on table public.page_views from public, anon, authenticated;
grant insert on table public.page_views to anon, authenticated;

create policy page_views_insert on public.page_views
  for insert
  to anon, authenticated
  with check (
    visitor_id is not null
    and path is not null
    and char_length(path) between 1 and 200
    and path like '/%'
    and path !~ E'[\\r\\n]'
    and (tab is null or (char_length(tab) between 1 and 40 and tab ~ '^[a-z0-9_-]+$'))
    and (
      referrer_domain is null
      or (char_length(referrer_domain) between 1 and 253 and referrer_domain ~ '^[A-Za-z0-9.-]+$')
    )
    and device in ('mobile', 'tablet', 'desktop')
  );

-- Owner-only daily stats in America/Chicago. Default last 14 days; own visits excluded unless asked.
create or replace function public.admin_visitor_stats(
  p_days int default 14,
  p_include_owner boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  n int := least(greatest(coalesce(p_days, 14), 1), 90);
  include_owner boolean := coalesce(p_include_owner, false);
  start_day date;
  end_day date;
  result jsonb;
begin
  if uid is null or not exists (select 1 from private.app_admins a where a.user_id = uid) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  end_day := (now() at time zone 'America/Chicago')::date;
  start_day := end_day - (n - 1);

  with
  filtered as (
    select
      pv.*,
      (pv.created_at at time zone 'America/Chicago')::date as day
    from public.page_views pv
    where pv.created_at >= (start_day::timestamp at time zone 'America/Chicago')
      and pv.created_at < ((end_day + 1)::timestamp at time zone 'America/Chicago')
      and (include_owner or pv.is_owner is not true)
  ),
  days as (
    select generate_series(start_day, end_day, interval '1 day')::date as day
  ),
  daily as (
    select
      d.day,
      coalesce(count(f.id), 0)::int as views,
      coalesce(count(distinct f.visitor_id), 0)::int as unique_visitors,
      coalesce(count(distinct f.visitor_id) filter (where f.signed_in is not true), 0)::int as guests,
      coalesce(count(distinct f.visitor_id) filter (where f.signed_in is true), 0)::int as signed_in
    from days d
    left join filtered f on f.day = d.day
    group by d.day
  ),
  pages as (
    select
      f.path,
      f.tab,
      count(*)::int as views,
      count(distinct f.visitor_id)::int as unique_visitors
    from filtered f
    group by f.path, f.tab
    order by count(*) desc, f.path, f.tab
    limit 15
  ),
  referrers as (
    select
      coalesce(f.referrer_domain, 'direct') as domain,
      count(*)::int as views,
      count(distinct f.visitor_id)::int as unique_visitors
    from filtered f
    group by 1
    order by count(*) desc, 1
    limit 15
  ),
  devices as (
    select
      f.device,
      count(*)::int as views,
      count(distinct f.visitor_id)::int as unique_visitors
    from filtered f
    group by f.device
    order by count(*) desc, f.device
  )
  select jsonb_build_object(
    'generated_at', now(),
    'timezone', 'America/Chicago',
    'days', n,
    'include_owner', include_owner,
    'range_start', start_day,
    'range_end', end_day,
    'totals', jsonb_build_object(
      'views', (select coalesce(sum(views), 0)::int from daily),
      'unique_visitors', (select count(distinct visitor_id)::int from filtered),
      'guests', (select count(distinct visitor_id)::int from filtered where signed_in is not true),
      'signed_in', (select count(distinct visitor_id)::int from filtered where signed_in is true)
    ),
    'daily', coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from daily d), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(to_jsonb(p)) from pages p), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(to_jsonb(r)) from referrers r), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(to_jsonb(d)) from devices d), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_visitor_stats(int, boolean) from public;
revoke all on function public.admin_visitor_stats(int, boolean) from anon;
grant execute on function public.admin_visitor_stats(int, boolean) to authenticated;
