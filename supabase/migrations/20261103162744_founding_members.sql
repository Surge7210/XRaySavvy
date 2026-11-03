-- Applied to Supabase project fnopntlihakgrydvwdge as migration "founding_members" (20261103162744).
-- Founding Members: the first 100 accounts (sign-up order, owner included) get founding_member = true.
-- founding_number is internal only (not shown in the UI). Clients can never set or change either column:
--   * column privileges: authenticated may INSERT only (id, display_name, created_at) and UPDATE only display_name
--   * a BEFORE INSERT/UPDATE trigger (security definer) assigns the values itself and freezes them on update.
-- The cap counts current founding members, so a deleted account frees its spot; numbers are never reused.
-- Anyone (signed in or not) can read only the number of spots left via public.founding_spots_left().
alter table public.profiles
  add column founding_member boolean not null default false,
  add column founding_number integer unique check (founding_number is null or founding_number > 0);
alter table public.profiles
  add constraint profiles_founding_consistent check (founding_member = (founding_number is not null));
comment on column public.profiles.founding_member is 'Founding Member (first 100 accounts): free lifetime Pro when Pro launches. Set by trigger only.';
comment on column public.profiles.founding_number is 'Internal sign-up order among founding members (1 = first). Not shown in the UI yet. Set by trigger only.';

-- Backfill existing accounts in auth.users created_at order (before the trigger exists).
update public.profiles p
set founding_member = true, founding_number = o.n
from (
  select u.id, row_number() over (order by u.created_at, u.id) as n
  from auth.users u join public.profiles pp on pp.id = u.id
) o
where p.id = o.id and o.n <= 100;

-- Only the listed columns are writable by signed-in users (founding_* excluded).
revoke insert, update on table public.profiles from anon, authenticated;
grant insert (id, display_name, created_at) on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

create or replace function private.profiles_founding_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare taken int; nxt int;
begin
  if tg_op = 'UPDATE' then
    new.founding_member := old.founding_member;
    new.founding_number := old.founding_number;
    return new;
  end if;
  -- INSERT: ignore anything the caller sent and assign in sign-up order (serialised by a lock).
  new.founding_member := false;
  new.founding_number := null;
  perform pg_advisory_xact_lock(hashtext('xraysavvy.founding_members'));
  select count(*), coalesce(max(founding_number), 0) into taken, nxt from public.profiles where founding_member;
  if taken < 100 then
    new.founding_member := true;
    new.founding_number := nxt + 1;
  end if;
  return new;
end $$;
revoke all on function private.profiles_founding_guard() from public, anon, authenticated;

create trigger profiles_founding_guard before insert or update on public.profiles
  for each row execute function private.profiles_founding_guard();

-- Public: just the number of Founding spots left (0..100). No personal data.
create or replace function public.founding_spots_left()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, 100 - count(*))::int from public.profiles where founding_member
$$;
revoke all on function public.founding_spots_left() from public;
grant execute on function public.founding_spots_left() to anon, authenticated;
