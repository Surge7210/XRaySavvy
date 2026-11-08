-- Applied to Supabase project fnopntlihakgrydvwdge as migration "shared_flashcards_by_category" (20261108182201).
-- Category-level ("deck") sharing: publish/refresh or unpublish ALL of the caller's own cards in one category, atomically.
-- Category match = case-insensitive, whitespace-collapsed subject of the caller's CURRENT personal cards.
create or replace function private.fc_cat(t text)
returns text language sql immutable set search_path = '' as $$ select lower(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g')) $$;

create or replace function public.flashcard_share_category(p_subject text, p_author text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); k text := private.fc_cat(p_subject); a text; n int; mine int; extra int;
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if k = '' then raise exception 'bad_category' using errcode = 'P0001'; end if;
  a := btrim(regexp_replace(coalesce(p_author, ''), '[[:cntrl:]]|\s+', ' ', 'g'));
  if char_length(a) < 1 or char_length(a) > 40 then raise exception 'bad_name: display name must be 1-40 characters' using errcode = 'P0001'; end if;
  if a ~* '[a-z0-9._%+-]+@[a-z0-9.-]+' then raise exception 'bad_name: please don''t use an email address' using errcode = 'P0001'; end if;
  select count(*) into mine from public.personal_flashcards c where c.user_id = uid and private.fc_cat(c.subject) = k;
  if mine = 0 then raise exception 'empty_category' using errcode = 'P0001'; end if;
  select count(*) into extra from public.personal_flashcards c where c.user_id = uid and private.fc_cat(c.subject) = k
    and not exists (select 1 from public.shared_flashcards s where s.personal_card_id = c.id);
  select count(*) into n from public.shared_flashcards where user_id = uid;
  if n + extra > 500 then raise exception 'share_limit: at most 500 shared cards' using errcode = 'P0001'; end if;
  insert into public.shared_flashcards (user_id, personal_card_id, subject, term, definition, author_name)
    select uid, c.id, btrim(c.subject), btrim(c.term), btrim(c.definition), a
    from public.personal_flashcards c where c.user_id = uid and private.fc_cat(c.subject) = k
  on conflict (personal_card_id) do update set subject = excluded.subject, term = excluded.term,
    definition = excluded.definition, author_name = excluded.author_name, updated_at = now()
    where public.shared_flashcards.user_id = uid;
  return jsonb_build_object('shared', mine, 'author_name', a);
end $$;

create or replace function public.flashcard_unshare_category(p_subject text)
returns integer language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); k text := private.fc_cat(p_subject); r int;
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if k = '' then raise exception 'bad_category' using errcode = 'P0001'; end if;
  delete from public.shared_flashcards s where s.user_id = uid and s.personal_card_id in
    (select c.id from public.personal_flashcards c where c.user_id = uid and private.fc_cat(c.subject) = k);
  get diagnostics r = row_count; return r;
end $$;

revoke all on function private.fc_cat(text) from public, anon, authenticated;
revoke all on function public.flashcard_share_category(text, text) from public, anon;
revoke all on function public.flashcard_unshare_category(text) from public, anon;
grant execute on function public.flashcard_share_category(text, text), public.flashcard_unshare_category(text) to authenticated;
