-- Applied to Supabase project fnopntlihakgrydvwdge as migration "flashcard_progress" (20261108005839).
-- Private per-student flashcard review progress (cross-device sync).
-- Card text stays public in flashcards.js; this table holds ONLY each user's own scheduling state.
create table public.flashcard_progress (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card_key text not null check (card_key ~ '^[a-z0-9-]{1,40}:[0-9]{1,4}(:r)?$'),
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 1024),
  reviewed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, card_key)
);
comment on table public.flashcard_progress is 'Each user''s private flashcard scheduling state. Own rows only (RLS).';

alter table public.flashcard_progress enable row level security;
create policy "flashcard_progress: read own" on public.flashcard_progress for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "flashcard_progress: insert own" on public.flashcard_progress for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "flashcard_progress: update own" on public.flashcard_progress for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "flashcard_progress: delete own" on public.flashcard_progress for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.flashcard_progress from public, anon, authenticated;
grant select, insert, update, delete on table public.flashcard_progress to authenticated;

-- Guard: older reviews never overwrite newer ones; no far-future timestamps; per-user row cap. Runs as caller.
create or replace function private.flashcard_progress_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare n int;
begin
  if new.reviewed_at > now() + interval '10 minutes' then
    new.reviewed_at := now();
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    select count(*) into n from public.flashcard_progress where user_id = new.user_id;
    if n >= 20000 then
      raise exception 'flashcard_limit: too many saved cards' using errcode = 'P0001';
    end if;
  else
    if new.user_id <> old.user_id or new.card_key <> old.card_key then
      raise exception 'flashcard_immutable: user and card cannot change' using errcode = 'P0001';
    end if;
    if new.reviewed_at <= old.reviewed_at then
      return old; -- keep the newer review already saved
    end if;
  end if;
  return new;
end $$;
revoke all on function private.flashcard_progress_guard() from public, anon, authenticated;

create trigger flashcard_progress_guard before insert or update on public.flashcard_progress
  for each row execute function private.flashcard_progress_guard();
