-- Applied to Supabase project fnopntlihakgrydvwdge as migration "shared_flashcards" (20261108165658).
-- Student-shared flashcards: a card owner can opt in to publish a SNAPSHOT of one of their own personal cards
-- on the Flashcards tab with a display name they choose. Not reviewed; separate from reviewed community_flashcards.
-- All writes go through RPCs that check auth.uid(); public can read only minimal columns of non-hidden rows.
create table public.shared_flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  personal_card_id uuid not null unique references public.personal_flashcards(id) on delete cascade,
  subject text not null check (char_length(btrim(subject)) between 1 and 60),
  term text not null check (char_length(btrim(term)) between 1 and 120),
  definition text not null check (char_length(btrim(definition)) between 1 and 1000),
  author_name text not null check (char_length(btrim(author_name)) between 1 and 40),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shared_flashcards_user_idx on public.shared_flashcards (user_id);
create index shared_flashcards_list_idx on public.shared_flashcards (subject, term) where not hidden;
alter table public.shared_flashcards enable row level security;
create policy "shared_flashcards: public read visible" on public.shared_flashcards for select to anon, authenticated using (not hidden);
revoke all on table public.shared_flashcards from public, anon, authenticated;
grant select (id, subject, term, definition, author_name, created_at) on table public.shared_flashcards to anon, authenticated;

-- Publish or refresh the shared copy of ONE of the caller's own cards.
create or replace function public.flashcard_share(p_card_id uuid, p_author text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); c public.personal_flashcards; a text; n int; r public.shared_flashcards;
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.personal_flashcards where id = p_card_id and user_id = uid;
  if not found then raise exception 'bad_card: not your card' using errcode = '42501'; end if;
  a := btrim(regexp_replace(coalesce(p_author, ''), '[[:cntrl:]]|\s+', ' ', 'g'));
  if char_length(a) < 1 or char_length(a) > 40 then raise exception 'bad_name: display name must be 1-40 characters' using errcode = 'P0001'; end if;
  if a ~* '[a-z0-9._%+-]+@[a-z0-9.-]+' then raise exception 'bad_name: please don''t use an email address' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.shared_flashcards where personal_card_id = c.id) then
    select count(*) into n from public.shared_flashcards where user_id = uid;
    if n >= 500 then raise exception 'share_limit: at most 500 shared cards' using errcode = 'P0001'; end if;
  end if;
  insert into public.shared_flashcards (user_id, personal_card_id, subject, term, definition, author_name)
    values (uid, c.id, btrim(c.subject), btrim(c.term), btrim(c.definition), a)
  on conflict (personal_card_id) do update set subject = excluded.subject, term = excluded.term,
    definition = excluded.definition, author_name = excluded.author_name, updated_at = now()
    where public.shared_flashcards.user_id = uid
  returning * into r;
  if r.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('personal_card_id', r.personal_card_id, 'author_name', r.author_name, 'hidden', r.hidden, 'updated_at', r.updated_at);
end $$;

create or replace function public.flashcard_unshare(p_card_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); k int;
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.shared_flashcards where personal_card_id = p_card_id and user_id = uid;
  get diagnostics k = row_count;
  return k > 0;
end $$;

-- Caller's own shared status (includes cards hidden by the site owner).
create or replace function public.my_shared_flashcards()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('personal_card_id', s.personal_card_id, 'author_name', s.author_name,
    'hidden', s.hidden, 'subject', s.subject, 'term', s.term, 'definition', s.definition, 'updated_at', s.updated_at))
    from public.shared_flashcards s where s.user_id = uid), '[]'::jsonb);
end $$;

-- Owner (private.app_admins) safety moderation: list / hide / unhide / remove.
create or replace function public.admin_shared_flashcards()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from private.app_admins a where a.user_id = uid) then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'subject', s.subject, 'term', s.term, 'definition', s.definition,
    'author_name', s.author_name, 'hidden', s.hidden, 'updated_at', s.updated_at) order by s.updated_at desc)
    from public.shared_flashcards s), '[]'::jsonb);
end $$;
create or replace function public.admin_shared_flashcard_set(p_id uuid, p_action text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); k int;
begin
  if uid is null or not exists (select 1 from private.app_admins a where a.user_id = uid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_action = 'hide' then update public.shared_flashcards set hidden = true where id = p_id;
  elsif p_action = 'unhide' then update public.shared_flashcards set hidden = false where id = p_id;
  elsif p_action = 'remove' then delete from public.shared_flashcards where id = p_id;
  else raise exception 'bad_action' using errcode = 'P0001'; end if;
  get diagnostics k = row_count; return k > 0;
end $$;

revoke all on function public.flashcard_share(uuid, text) from public, anon;
revoke all on function public.flashcard_unshare(uuid) from public, anon;
revoke all on function public.my_shared_flashcards() from public, anon;
revoke all on function public.admin_shared_flashcards() from public, anon;
revoke all on function public.admin_shared_flashcard_set(uuid, text) from public, anon;
grant execute on function public.flashcard_share(uuid, text), public.flashcard_unshare(uuid), public.my_shared_flashcards(),
  public.admin_shared_flashcards(), public.admin_shared_flashcard_set(uuid, text) to authenticated;
