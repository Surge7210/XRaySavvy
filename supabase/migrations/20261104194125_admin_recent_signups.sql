-- Owner-only list of the newest accounts for admin.html ("Recent sign-ups" card).
-- Same security pattern as public.admin_usage(): SECURITY DEFINER, empty search_path,
-- caller must be in private.app_admins, otherwise 42501 'not allowed'.
-- Returns the email HANDLE only (part before @), never the full address.
create or replace function public.admin_recent_signups(limit_n int default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  n int := least(greatest(coalesce(limit_n, 25), 1), 100);
  result jsonb;
begin
  if uid is null or not exists (select 1 from private.app_admins a where a.user_id = uid) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'accounts_total', (select count(*) from auth.users),
    'accounts_new_24h', (select count(*) from auth.users where created_at > now() - interval '24 hours'),
    'signups', coalesce((
      select jsonb_agg(r order by r.created_at desc)
      from (
        select
          split_part(u.email, '@', 1) as handle,
          nullif(btrim(p.display_name), '') as display_name,
          u.created_at,
          (u.email_confirmed_at is not null) as confirmed,
          u.last_sign_in_at,
          case when coalesce(p.founding_member, false) then p.founding_number end as founding_number,
          (select count(*) from public.quiz_results q where q.user_id = u.id) as quiz_answers,
          (select max(q.created_at) from public.quiz_results q where q.user_id = u.id) as last_quiz_at
        from auth.users u
        left join public.profiles p on p.id = u.id
        order by u.created_at desc
        limit n
      ) r
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.admin_recent_signups(int) from public;
revoke all on function public.admin_recent_signups(int) from anon;
grant execute on function public.admin_recent_signups(int) to authenticated;
