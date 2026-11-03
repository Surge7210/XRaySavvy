-- Applied to Supabase project fnopntlihakgrydvwdge as migration "shared_decks_readonly_links" (20261103060025).
-- Read-only shareable deck links.
-- Owners manage their own rows (RLS). Nobody can SELECT the table except the owner;
-- viewers (anon or signed in) read ONE non-revoked snapshot through public.get_shared_deck(share_id).
create table public.shared_decks (
  id text primary key check (id ~ '^[A-Za-z0-9]{10,32}$'),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  deck_client_id text check (deck_client_id is null or char_length(deck_client_id) <= 100),
  title text not null check (char_length(title) between 1 and 200),
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 1048576),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked boolean not null default false
);
comment on table public.shared_decks is 'Immutable snapshots of decks shared by link. No public select; read via get_shared_deck().';
create index shared_decks_owner_created_idx on public.shared_decks (owner, created_at desc);

alter table public.shared_decks enable row level security;

create policy "shared_decks: read own" on public.shared_decks for select to authenticated
  using ((select auth.uid()) = owner);
create policy "shared_decks: insert own" on public.shared_decks for insert to authenticated
  with check ((select auth.uid()) = owner);
create policy "shared_decks: update own" on public.shared_decks for update to authenticated
  using ((select auth.uid()) = owner) with check ((select auth.uid()) = owner);
create policy "shared_decks: delete own" on public.shared_decks for delete to authenticated
  using ((select auth.uid()) = owner);

revoke all on table public.shared_decks from public, anon;
revoke all on table public.shared_decks from authenticated;
grant select, insert, update, delete on table public.shared_decks to authenticated;

-- Limits + immutable columns. Runs as the caller (RLS lets the owner count only their own rows).
create or replace function private.shared_decks_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare n int;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    select count(*) into n from public.shared_decks where owner = new.owner;
    if n >= 200 then
      raise exception 'share_limit: you can have at most 200 shared links. Turn off or delete some first.' using errcode = 'P0001';
    end if;
    select count(*) into n from public.shared_decks where owner = new.owner and created_at > now() - interval '1 hour';
    if n >= 30 then
      raise exception 'share_rate: too many new share links in the last hour. Please try again later.' using errcode = 'P0001';
    end if;
  else
    if new.id <> old.id or new.owner <> old.owner then
      raise exception 'share_immutable: id and owner cannot change' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
    new.updated_at := case when new.content is distinct from old.content or new.title is distinct from old.title then now() else old.updated_at end;
  end if;
  return new;
end $$;
revoke all on function private.shared_decks_guard() from public, anon, authenticated;

create trigger shared_decks_guard before insert or update on public.shared_decks
  for each row execute function private.shared_decks_guard();

-- The ONLY way to read a shared deck: one row by its unguessable id, only while not revoked.
-- Returns no owner id/email; at most the first word of the owner's optional display name.
create or replace function public.get_shared_deck(share_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'title', s.title,
    'content', s.content,
    'updated_at', s.updated_at,
    'by', nullif(left(split_part(btrim(coalesce(p.display_name, '')), ' ', 1), 30), '')
  )
  from public.shared_decks s
  left join public.profiles p on p.id = s.owner
  where share_id ~ '^[A-Za-z0-9]{10,32}$'
    and s.id = share_id
    and not s.revoked
$$;
revoke all on function public.get_shared_deck(text) from public;
grant execute on function public.get_shared_deck(text) to anon, authenticated;
