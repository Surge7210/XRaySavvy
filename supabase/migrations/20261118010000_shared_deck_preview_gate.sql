-- Applied to Supabase project fnopntlihakgrydvwdge as migration "shared_deck_preview_gate" (20261118010000).
-- Soft signup gate for shared-deck links.
-- Signed-in callers still get the full snapshot (existing links keep working).
-- Signed-out callers get a preview-sized payload only: the first 3 Learn quiz
-- questions and the section(s) they belong to, and the first 8 Cram questions
-- (roughly the first section of a Cram sheet), plus totals so the UI can say
-- "3 of 40". Owner id and email are still never returned. No data is deleted.

create or replace function public.get_shared_deck(share_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.shared_decks%rowtype;
  by_name text;
  content jsonb;
  lq jsonb;
  cq jsonb;
  secs jsonb;
  lq_keep jsonb;
  cq_keep jsonb;
  secs_keep jsonb;
  max_sec int;
  preview boolean;
  lq_n int;
  cq_n int;
  sec_n int;
begin
  if share_id is null or share_id !~ '^[A-Za-z0-9]{10,32}$' then
    return null;
  end if;

  select sd.* into s
  from public.shared_decks sd
  where sd.id = share_id and not sd.revoked;
  if not found then
    return null;
  end if;

  select nullif(left(split_part(btrim(coalesce(p.display_name, '')), ' ', 1), 30), '')
    into by_name
  from public.profiles p
  where p.id = s.owner;

  content := s.content;
  lq := case when jsonb_typeof(content->'learnQuestions') = 'array' then content->'learnQuestions' else '[]'::jsonb end;
  cq := case when jsonb_typeof(content->'cramQuestions') = 'array' then content->'cramQuestions' else '[]'::jsonb end;
  secs := case when jsonb_typeof(content->'sections') = 'array' then content->'sections' else '[]'::jsonb end;
  lq_n := jsonb_array_length(lq);
  cq_n := jsonb_array_length(cq);
  sec_n := jsonb_array_length(secs);

  lq_keep := coalesce((
    select jsonb_agg(elem order by ord)
    from (
      select elem, ord
      from jsonb_array_elements(lq) with ordinality as t(elem, ord)
      order by ord
      limit 3
    ) x
  ), '[]'::jsonb);

  max_sec := coalesce((
    select max((elem->>'section')::int)
    from jsonb_array_elements(lq_keep) elem
    where (elem->>'section') ~ '^[0-9]+$'
  ), -1);

  if max_sec < 0 and sec_n > 0 then
    max_sec := 0;
  end if;

  secs_keep := case
    when max_sec < 0 then '[]'::jsonb
    else coalesce((
      select jsonb_agg(elem order by ord)
      from (
        select elem, ord
        from jsonb_array_elements(secs) with ordinality as t(elem, ord)
        where ord <= max_sec + 1
        order by ord
      ) x
    ), '[]'::jsonb)
  end;

  if max_sec >= 0 then
    lq_keep := coalesce((
      select jsonb_agg(elem order by ord)
      from (
        select elem, ord
        from jsonb_array_elements(lq_keep) with ordinality as t(elem, ord)
        where (elem->>'section') is null
           or ((elem->>'section') ~ '^[0-9]+$' and (elem->>'section')::int <= max_sec)
        order by ord
      ) x
    ), '[]'::jsonb);
  end if;

  cq_keep := coalesce((
    select jsonb_agg(elem order by ord)
    from (
      select elem, ord
      from jsonb_array_elements(cq) with ordinality as t(elem, ord)
      order by ord
      limit 8
    ) x
  ), '[]'::jsonb);

  preview := (auth.uid() is null) and (
    lq_n > jsonb_array_length(lq_keep)
    or cq_n > jsonb_array_length(cq_keep)
    or sec_n > jsonb_array_length(secs_keep)
  );

  if preview then
    content := content || jsonb_build_object(
      'learnQuestions', lq_keep,
      'cramQuestions', cq_keep,
      'sections', secs_keep
    );
  end if;

  return jsonb_build_object(
    'id', s.id,
    'title', s.title,
    'content', content,
    'updated_at', s.updated_at,
    'by', by_name,
    'preview', preview,
    'totals', jsonb_build_object(
      'sections', sec_n,
      'learnQuestions', lq_n,
      'cramQuestions', cq_n
    )
  );
end;
$$;

revoke all on function public.get_shared_deck(text) from public;
grant execute on function public.get_shared_deck(text) to anon, authenticated;

comment on function public.get_shared_deck(text) is
  'Read one non-revoked shared deck. Signed-in callers get the full snapshot; signed-out callers get a preview (first 3 Learn questions and covering sections, first 8 Cram questions) plus totals. Never returns the owner id or email.';
