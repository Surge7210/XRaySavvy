-- Applied to Supabase project fnopntlihakgrydvwdge as migration "personal_flashcards_and_suggestions" (20261108011305).
-- Personal flashcards (signed-in only, private) + "Submit to XRaySavvy" suggestions with owner-only moderation.
-- Public sees ONLY approved snapshots in public.community_flashcards. Built-in curated decks live in flashcards.js and are never touched.

-- Progress keys: allow stable card ids (personal/community uuids) in addition to built-in indexes.
alter table public.flashcard_progress drop constraint if exists flashcard_progress_card_key_check;
alter table public.flashcard_progress add constraint flashcard_progress_card_key_check
  check (card_key ~ '^[a-z0-9-]{1,40}:[a-z0-9-]{1,40}(:r)?$');

create or replace function private.fc_norm(t text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g')), '(\w{3,})(es|s)$', '\1')
$$;

-- 1) Personal cards: own rows only.
create table public.personal_flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subject text not null check (char_length(btrim(subject)) between 1 and 60),
  term text not null check (char_length(btrim(term)) between 1 and 120),
  definition text not null check (char_length(btrim(definition)) between 1 and 1000),
  source text check (source is null or char_length(source) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index personal_flashcards_user_idx on public.personal_flashcards (user_id, created_at);
alter table public.personal_flashcards enable row level security;
create policy "personal_flashcards: read own" on public.personal_flashcards for select to authenticated using ((select auth.uid()) = user_id);
create policy "personal_flashcards: insert own" on public.personal_flashcards for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "personal_flashcards: update own" on public.personal_flashcards for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "personal_flashcards: delete own" on public.personal_flashcards for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.personal_flashcards from public, anon, authenticated;
grant select, insert, update, delete on table public.personal_flashcards to authenticated;

create or replace function private.personal_flashcards_guard()
returns trigger language plpgsql set search_path = '' as $$
declare n int;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    select count(*) into n from public.personal_flashcards where user_id = new.user_id;
    if n >= 2000 then raise exception 'card_limit: you can have at most 2000 personal cards' using errcode = 'P0001'; end if;
  elsif new.id <> old.id or new.user_id <> old.user_id then
    raise exception 'card_immutable: id and owner cannot change' using errcode = 'P0001';
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger personal_flashcards_guard before insert or update on public.personal_flashcards
  for each row execute function private.personal_flashcards_guard();

-- 2) Approved community cards (public read, no client writes).
create table public.community_flashcards (
  id uuid primary key default gen_random_uuid(),
  subject text not null check (char_length(subject) between 1 and 60),
  term text not null check (char_length(term) between 1 and 120),
  definition text not null check (char_length(definition) between 1 and 1000),
  source text check (source is null or char_length(source) <= 300),
  term_norm text not null,
  suggestion_id uuid,
  approved_at timestamptz not null default now()
);
create index community_flashcards_norm_idx on public.community_flashcards (term_norm);
alter table public.community_flashcards enable row level security;
create policy "community_flashcards: public read" on public.community_flashcards for select to anon, authenticated using (true);
revoke all on table public.community_flashcards from public, anon, authenticated;
grant select on table public.community_flashcards to anon, authenticated;

-- 3) Suggestions: immutable snapshots; submitter can read own + insert pending; nobody else but admins (via RPC).
create table public.flashcard_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  personal_card_id uuid references public.personal_flashcards(id) on delete set null,
  subject text not null check (char_length(btrim(subject)) between 1 and 60),
  term text not null check (char_length(btrim(term)) between 1 and 120),
  definition text not null check (char_length(btrim(definition)) between 1 and 1000),
  source text check (source is null or char_length(source) <= 300),
  term_norm text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'merged')),
  owner_note text check (owner_note is null or char_length(owner_note) <= 500),
  community_card_id uuid references public.community_flashcards(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index flashcard_suggestions_user_idx on public.flashcard_suggestions (user_id, created_at desc);
create index flashcard_suggestions_status_idx on public.flashcard_suggestions (status, created_at);
create index flashcard_suggestions_norm_idx on public.flashcard_suggestions (term_norm);
alter table public.flashcard_suggestions enable row level security;
create policy "flashcard_suggestions: read own" on public.flashcard_suggestions for select to authenticated using ((select auth.uid()) = user_id);
create policy "flashcard_suggestions: submit own pending" on public.flashcard_suggestions for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'pending' and reviewed_at is null and owner_note is null and community_card_id is null);
revoke all on table public.flashcard_suggestions from public, anon, authenticated;
grant select, insert on table public.flashcard_suggestions to authenticated;

create or replace function private.flashcard_suggestions_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  new.status := 'pending'; new.reviewed_at := null; new.owner_note := null; new.community_card_id := null;
  new.created_at := now();
  new.term_norm := private.fc_norm(new.term);
  if new.term_norm = '' then raise exception 'bad_term: term needs letters or numbers' using errcode = 'P0001'; end if;
  if new.personal_card_id is not null and not exists (select 1 from public.personal_flashcards p where p.id = new.personal_card_id and p.user_id = new.user_id) then
    raise exception 'bad_card: not your card' using errcode = '42501';
  end if;
  select count(*) into n from public.flashcard_suggestions where user_id = new.user_id and created_at > now() - interval '1 day';
  if n >= 25 then raise exception 'suggest_rate: at most 25 suggestions per day' using errcode = 'P0001'; end if;
  if exists (select 1 from public.flashcard_suggestions where user_id = new.user_id and status = 'pending' and term_norm = new.term_norm) then
    raise exception 'suggest_dup: you already have this term waiting for review' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger flashcard_suggestions_guard before insert on public.flashcard_suggestions
  for each row execute function private.flashcard_suggestions_guard();

-- Duplicate check for a signed-in user: published matches (public anyway), own pending, and ONLY a yes/no that someone else has it pending.
create or replace function public.flashcard_duplicate_check(p_term text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); n text := private.fc_norm(p_term);
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if n = '' or char_length(p_term) > 120 then return jsonb_build_object('norm', n, 'published', '[]'::jsonb, 'own_pending', false, 'pending_elsewhere', false); end if;
  return jsonb_build_object(
    'norm', n,
    'published', coalesce((select jsonb_agg(jsonb_build_object('term', c.term, 'exact', c.term_norm = n)) from (
        select term, term_norm from public.community_flashcards
        where term_norm = n or (char_length(n) >= 4 and (term_norm like '%' || n || '%' or n like '%' || term_norm || '%')) limit 5) c), '[]'::jsonb),
    'own_pending', exists (select 1 from public.flashcard_suggestions s where s.user_id = uid and s.status = 'pending' and s.term_norm = n),
    'pending_elsewhere', exists (select 1 from public.flashcard_suggestions s where s.user_id <> uid and s.status = 'pending' and s.term_norm = n)
  );
end $$;
revoke all on function public.flashcard_duplicate_check(text) from public, anon;
grant execute on function public.flashcard_duplicate_check(text) to authenticated;

-- Owner-only moderation (caller must be in private.app_admins; server-side check).
create or replace function public.admin_flashcard_suggestions(p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from private.app_admins a where a.user_id = uid) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(r order by r.created_at) from (
    select s.id, s.subject, s.term, s.definition, s.source, s.status, s.owner_note, s.created_at, s.reviewed_at, s.term_norm,
      split_part(u.email, '@', 1) as handle,
      (select jsonb_agg(c.term) from public.community_flashcards c where c.term_norm = s.term_norm) as published_dups,
      (select count(*) from public.flashcard_suggestions o where o.term_norm = s.term_norm and o.id <> s.id and o.status = 'pending') as other_pending
    from public.flashcard_suggestions s join auth.users u on u.id = s.user_id
    where s.status = coalesce(p_status, 'pending') order by s.created_at limit 200) r), '[]'::jsonb);
end $$;
revoke all on function public.admin_flashcard_suggestions(text) from public, anon;
grant execute on function public.admin_flashcard_suggestions(text) to authenticated;

create or replace function public.admin_review_flashcard_suggestion(p_id uuid, p_action text, p_subject text default null, p_term text default null,
  p_definition text default null, p_source text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); s public.flashcard_suggestions; cid uuid;
begin
  if uid is null or not exists (select 1 from private.app_admins a where a.user_id = uid) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.flashcard_suggestions where id = p_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if s.status <> 'pending' then raise exception 'already reviewed' using errcode = 'P0001'; end if;
  if p_action = 'approve' then
    insert into public.community_flashcards (subject, term, definition, source, term_norm, suggestion_id)
    values (btrim(coalesce(p_subject, s.subject)), btrim(coalesce(p_term, s.term)), btrim(coalesce(p_definition, s.definition)),
            nullif(btrim(coalesce(p_source, s.source, '')), ''), private.fc_norm(coalesce(p_term, s.term)), s.id)
    returning id into cid;
    update public.flashcard_suggestions set status = 'approved', reviewed_at = now(), owner_note = left(p_note, 500), community_card_id = cid where id = s.id;
  elsif p_action in ('reject', 'merge') then
    update public.flashcard_suggestions set status = case when p_action = 'reject' then 'rejected' else 'merged' end,
      reviewed_at = now(), owner_note = left(p_note, 500) where id = s.id;
  else
    raise exception 'bad action' using errcode = '22023';
  end if;
  return jsonb_build_object('id', s.id, 'status', p_action, 'community_card_id', cid);
end $$;
revoke all on function public.admin_review_flashcard_suggestion(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_review_flashcard_suggestion(uuid, text, text, text, text, text, text) to authenticated;

revoke all on function private.fc_norm(text) from public, anon, authenticated;
revoke all on function private.personal_flashcards_guard() from public, anon, authenticated;
revoke all on function private.flashcard_suggestions_guard() from public, anon, authenticated;
