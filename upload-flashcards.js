/* Upload page: "Make flashcards" from the uploaded notes.
 * Uses the existing Worker 'questions' action (short answer, grounded only in the text) — no new AI service.
 * Every generated card is a DRAFT: the student edits, picks a category, and taps Add for each one.
 * Nothing is saved automatically. Saves go to public.personal_flashcards (own rows only, RLS). Signed-in only. */
(function () {
  'use strict';
  var PRESETS = ['Positioning', 'Physics', 'Patient Care', 'Vocabulary', 'Anatomy', 'Radiation Protection'];
  var LIM = { subject: 60, term: 120, definition: 1000 };
  var FOCUS = 'FLASHCARDS: each item tests ONE key term or concept. Question: ask what a term means or names one concept (e.g. "What is ...?"). Answer: the key fact. Explanation: one-sentence definition from the text.';
  var VOCAB = "VOCABULARY CARDS: one item per vocabulary term defined in the text. answer: ONLY the term exactly as written in the text. explanation: its definition as one short sentence from the text, NOT starting with the term or 'is defined as'. question: 'Define: <term>'. Fewer items is fine; never pad.";
  // Vocabulary card = term on front, plain definition on back. Only accepted when the term really
  // appears in the source; otherwise the card stays in question/answer form (never invent terms).
  function cleanDef(def, term) {
    var d = String(def || '').replace(/\s+/g, ' ').trim();
    var t = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    d = d.replace(new RegExp('^(the term\\s+)?(an?\\s+)?' + t + '\\s*(\\([^)]*\\)\\s*)?(:|-|–|—|is defined as|is|are|means|refers to|describes)\\s+', 'i'), '');
    d = d.replace(/^(is defined as|defined as|refers to|means)\s+/i, '');
    if (!d) return '';
    d = d.charAt(0).toUpperCase() + d.slice(1);
    return /[.!?]$/.test(d) ? d : d + '.';
  }
  function vocabCard(q, srcLow) {
    // Only 'Define: X' items, or questions that explicitly ask for a term/word, become term cards.
    var qs = String(q.question || ''), m = qs.match(/^\s*(?:define|term)\s*:\s*(.+)$/i), cand;
    if (m) { if (q.answer && norm(q.answer) !== norm(m[1])) return null; cand = [m[1]]; }
    else if (/\b(term|word)\b/i.test(qs)) cand = [String(q.answer || '')];
    else return null;
    for (var i = 0; i < cand.length; i++) {
      var term = cand[i].replace(/\s+/g, ' ').trim().replace(/[.?!:]+$/, '');
      if (!term || term.length > 60 || term.split(' ').length > 6 || srcLow.indexOf(term.toLowerCase()) < 0) continue;
      var def = cleanDef(q.explanation, term);
      if (!def || norm(def) === norm(term) || def.length < 8) continue;
      return { term: term, definition: def };
    }
    return null;
  }
  var st = { uid: null, drafts: [], running: false, cancel: false, mineNorms: null, saved: 0, discarded: 0, cat: 'Vocabulary', src: '' };
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function uid() { return (window.XRS && XRS.user && XRS.user.id) || null; }
  function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/(\w{3,})(es|s)$/, '$1'); }
  function catClean(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function clip(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function reset(u) { st = { uid: u, drafts: [], running: false, cancel: true, mineNorms: null, saved: 0, discarded: 0, cat: st.cat || 'Vocabulary', src: '' }; }

  function box() { return $('flashCard'); }
  function show(on) {
    var b = box(), btn = $('flashBtn'); if (!b) return;
    b.classList.toggle('hidden', !on); if (btn) btn.classList.toggle('active', !!on);
    if (on) { paint(); b.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  window.XRS_UPLOAD_FLASH = { show: show, state: function () { return st; } };

  function paint() {
    var b = box(); if (!b) return;
    var u = uid();
    if (!u) {
      b.innerHTML = '<h2>🃏 Make flashcards</h2><p class="muted small">Turn these notes into flashcards you review before they’re added to your private My Flashcards. Free account required.</p>' +
        '<div class="row"><button class="btn btn-primary" data-auth="signup" type="button">Sign up free</button><button class="btn btn-secondary" data-auth="login" type="button">Log in</button></div>';
      b.querySelectorAll('[data-auth]').forEach(function (x) { x.onclick = function () { if (window.XRS && XRS.openAuth) XRS.openAuth(x.getAttribute('data-auth')); }; });
      return;
    }
    if (st.uid !== u) reset(u);
    var x = window.__flashExtracted ? window.__flashExtracted() : null;
    if (!st.drafts.length && !st.running) {
      b.innerHTML = '<h2>🃏 Make flashcards</h2>' +
        (x ? '<p class="muted small">From: <b>' + esc(clip(x.fileName || 'your notes', 80)) + '</b>. Cards are made ONLY from this file. They’re drafts — you check each one, then Add or Discard. Nothing is saved until you tap Add.</p>' :
             '<div class="notice warn">Choose a file first (or open a saved deck whose notes were saved).</div>') +
        '<label class="lbl">How many cards?</label><div class="chips" id="ufCount"><button class="chip" data-v="10">10</button><button class="chip active" data-v="20">20</button><button class="chip" data-v="30">30</button></div>' +
        '<label class="lbl">Card style</label><div class="chips" id="ufStyle"><button class="chip active" data-v="vocab" type="button">Vocabulary (term → definition)</button><button class="chip" data-v="qa" type="button">Concept Q&amp;A</button></div>' +
        '<label class="lbl" for="ufFocus">Focus on (optional)</label><input type="text" id="ufFocus" maxlength="120" placeholder="e.g. contrast media terms">' +
        '<button class="btn btn-primary btn-block" id="ufGo" type="button" style="margin-top:0.8rem"' + (x ? '' : ' disabled') + '>Generate flashcards</button>' +
        '<div id="ufErr" class="notice err hidden" style="margin-top:0.8rem;margin-bottom:0"></div>';
      b.querySelectorAll('#ufCount .chip').forEach(function (c) { c.onclick = function () { b.querySelectorAll('#ufCount .chip').forEach(function (y) { y.classList.toggle('active', y === c); }); }; });
      b.querySelectorAll('#ufStyle .chip').forEach(function (c) { c.onclick = function () { b.querySelectorAll('#ufStyle .chip').forEach(function (y) { y.classList.toggle('active', y === c); }); }; });
      $('ufGo').onclick = generate;
      return;
    }
    if (st.running) return; // progress painted by generate()
    renderReview();
  }

  function err(msg) { var e = $('ufErr'); if (e) { e.textContent = msg; e.classList.toggle('hidden', !msg); } }

  async function generate() {
    var u = uid(); if (!u) return paint();
    var x = window.__flashExtracted && window.__flashExtracted();
    if (!x || !x.chunks || !x.chunks.length || !String(x.text || '').trim()) return err('No readable text was found in this file, so there’s nothing to make cards from.');
    if (String(x.text).replace(/\s+/g, ' ').trim().length < 40) return err('This file has too little readable text to make flashcards.');
    var n = Number((box().querySelector('#ufCount .chip.active') || {}).getAttribute ? box().querySelector('#ufCount .chip.active').getAttribute('data-v') : 20) || 20;
    var userFocus = ($('ufFocus').value || '').trim().slice(0, 120);
    var style = ((box().querySelector('#ufStyle .chip.active') || { getAttribute: function () { return 'vocab'; } }).getAttribute('data-v')) || 'vocab';
    var srcLow = String(x.text).replace(/\s+/g, ' ').toLowerCase();
    var focus = ((style === 'vocab' ? VOCAB : FOCUS) + (userFocus ? ' Prefer: ' + userFocus : '')).slice(0, 300);
    st.running = true; st.cancel = false; st.src = x.fileName || 'your notes';
    var b = box();
    b.innerHTML = '<h2>🃏 Making flashcards…</h2><div class="muted" id="ufMsg">Starting…</div><div class="progress"><div id="ufBar"></div></div><div class="row"><button class="btn btn-secondary" id="ufStop" type="button">Stop</button></div><div id="ufErr" class="notice err hidden"></div>';
    $('ufStop').onclick = function () { st.cancel = true; };
    var reqs = planRequests(x.chunks, Math.min(30, n)), out = [], qaSpare = [], seen = {}, stop = '';
    for (var i = 0; i < reqs.length && !st.cancel; i++) {
      if ($('ufMsg')) $('ufMsg').textContent = 'Reading part ' + (i + 1) + ' of ' + reqs.length + ' (' + out.length + ' cards so far)';
      if ($('ufBar')) $('ufBar').style.width = Math.round(i / reqs.length * 100) + '%';
      var tries = 0;
      while (true) {
        try {
          var data = await callWorker({ action: 'questions', text: reqs[i].text, count: reqs[i].count, type: 'short', focus: focus });
          (data.questions || []).forEach(function (q) {
            var v = style === 'vocab' ? vocabCard(q, srcLow) : null, front, back;
            if (!v && style === 'vocab' && /^\s*(define|term)\s*:/i.test(String(q.question || ''))) return; // unverifiable term: drop, never invent
            if (v) { front = clip(v.term, LIM.term); back = clip(v.definition, LIM.definition); }
            else {
              front = clip(q.question, LIM.term); var ans = clip(q.answer, 300), ex = clip(q.explanation, 600);
              if (!front || !ans) return;
              back = clip(ex && norm(ex).indexOf(norm(ans)) < 0 ? ans + ' — ' + ex : (ex || ans), LIM.definition);
            }
            var k = norm(front); if (!k || seen[k]) return; seen[k] = 1;
            if (style === 'vocab' && !v) { qaSpare.push({ id: 'q' + qaSpare.length + '-' + Date.now().toString(36), term: front, definition: back, kind: 'qa', hint: clip(q.sourceHint, 60), cat: st.cat, status: 'draft' }); return; }
            out.push({ id: 'd' + out.length + '-' + Date.now().toString(36), term: front, definition: back, kind: v ? 'vocab' : 'qa', hint: clip(q.sourceHint, 60), cat: st.cat, status: 'draft' });
          });
          break;
        } catch (e) {
          tries++; var d = e.data || {};
          if (e.status === 429 && !d.perDay && tries <= 3) { var w = Math.min(90, Math.max(20, d.retryAfterSeconds || 60)); for (var s = w; s > 0 && !st.cancel; s--) { if ($('ufMsg')) $('ufMsg').textContent = 'Free limit hit — waiting ' + s + 's'; await sleep(1000); } if (st.cancel) break; continue; }
          if (!e.status && tries <= 1) { await sleep(3000); continue; }
          stop = e.message || 'Something went wrong.'; break;
        }
      }
      if (stop) break;
      if (i < reqs.length - 1 && !st.cancel) await sleep(GAP_MS);
    }
    if (uid() !== u) return; // account changed while generating: drop everything
    st.running = false;
    var noTerms = !out.length && qaSpare.length;
    st.drafts = (noTerms ? qaSpare : out).slice(0, n);
    if (!st.drafts.length) { paint(); err(stop || 'No flashcards could be made from this text. Try a file with more readable text.'); return; }
    st.notice = (stop ? stop + ' Kept the ' + st.drafts.length + ' cards made so far.' : '') + (noTerms ? ' No vocabulary terms with definitions were found, so these are question/answer cards.' : '');
    await loadMineNorms(u);
    renderReview();
  }

  async function loadMineNorms(u) {
    try {
      var sb = await XRS.client();
      var r = await sb.from('personal_flashcards').select('term,subject').limit(2000);
      if (uid() !== u || r.error) return;
      st.mineNorms = {}; st.mineCats = {};
      (r.data || []).forEach(function (c) { st.mineNorms[norm(c.term)] = c.term; var k = catClean(c.subject).toLowerCase(); if (k && !st.mineCats[k]) st.mineCats[k] = catClean(c.subject); });
      st.mineCount = (r.data || []).length;
    } catch (e) { /* duplicate hints are best effort */ }
  }

  function catOptions() {
    var o = {}, order = [];
    function add(n) { var k = catClean(n).toLowerCase(); if (k && !o[k]) { o[k] = catClean(n); order.push(k); } }
    Object.keys(st.mineCats || {}).forEach(function (k) { add(st.mineCats[k]); }); PRESETS.forEach(add);
    order.sort(function (a, b) { return o[a].localeCompare(o[b]); });
    return order.map(function (k) { return o[k]; });
  }

  function dupNote(d) {
    var k = norm(d.term), notes = [];
    if (st.mineNorms && st.mineNorms[k]) notes.push('You already have “' + st.mineNorms[k] + '” in My Flashcards.');
    st.drafts.forEach(function (o) { if (o !== d && o.status !== 'discarded' && norm(o.term) === k) notes.push('Same as another card in this batch.'); });
    return notes;
  }

  function renderReview() {
    var b = box(); if (!b) return;
    var left = st.drafts.filter(function (d) { return d.status === 'draft' || d.status === 'error'; }).length;
    var cats = catOptions();
    var h = '<h2>🃏 Review your flashcards</h2>' +
      '<div class="notice info">Draft cards made by AI from <b>' + esc(clip(st.src, 80)) + '</b> — check each answer against your notes, edit if needed, then <b>Add</b> or <b>Discard</b>. Only cards you add are saved, privately, to My Flashcards.</div>' +
      (st.notice ? '<div class="notice warn">' + esc(st.notice) + '</div>' : '') +
      '<div class="muted small" id="ufCounts" aria-live="polite">' + left + ' to review · ' + st.saved + ' added · ' + st.discarded + ' discarded</div>' +
      '<datalist id="ufCats">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>';
    st.drafts.forEach(function (d, i) {
      if (d.status === 'discarded') return;
      var saved = d.status === 'saved', dn = saved ? [] : dupNote(d);
      h += '<div class="uf-card' + (saved ? ' uf-saved' : '') + '" data-i="' + i + '">' +
        (saved ? '<div class="uf-ok">✓ Added to My Flashcards (' + esc(d.cat) + ')</div><div class="uf-t">' + esc(d.term) + '</div><div class="muted small">' + esc(d.definition) + '</div>' :
        '<label class="lbl">Front (' + (d.kind === 'vocab' ? 'term' : 'question') + ')</label><input type="text" class="uf-term" maxlength="' + LIM.term + '" value="' + esc(d.term) + '">' +
        '<label class="lbl">Back (' + (d.kind === 'vocab' ? 'definition' : 'answer') + ')</label><textarea class="uf-def" rows="3" maxlength="' + LIM.definition + '">' + esc(d.definition) + '</textarea>' +
        '<label class="lbl">Category</label><div class="chips uf-cats" role="radiogroup" aria-label="Category">' +
          cats.map(function (c) { var on = c.toLowerCase() === catClean(d.cat).toLowerCase(); return '<button type="button" role="radio" aria-checked="' + on + '" class="chip' + (on ? ' active' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') +
        '</div><input type="text" class="uf-cat" maxlength="' + LIM.subject + '" list="ufCats" value="' + esc(d.cat) + '" aria-label="Category (choose above or type your own)" placeholder="Or type your own category">' +
        (d.hint ? '<div class="muted small" style="margin-top:0.3rem">Where to check: ' + esc(d.hint) + '</div>' : '') +
        (dn.length ? '<div class="uf-warn">' + dn.map(esc).join('<br>') + '</div>' : '') +
        (d.status === 'error' ? '<div class="uf-err">' + esc(d.error || 'Couldn’t save. Tap Add to try again.') + '</div>' : '') +
        '<div class="row"><button class="btn btn-primary uf-add" type="button"' + (d.status === 'saving' ? ' disabled' : '') + '>' + (d.status === 'saving' ? 'Adding…' : d.status === 'error' ? 'Try again' : 'Add to my deck') + '</button>' +
        '<button class="btn btn-secondary uf-del" type="button"' + (d.status === 'saving' ? ' disabled' : '') + '>Discard</button></div>') + '</div>';
    });
    if (!left) h += '<div class="notice info">Done: ' + st.saved + ' added, ' + st.discarded + ' discarded.</div>';
    h += '<div class="row"><a class="btn btn-secondary" href="./index.html#flashcards">Open My Flashcards →</a><button class="btn btn-secondary" id="ufNew" type="button">Start over</button></div>';
    b.innerHTML = h;
    b.querySelectorAll('.uf-card').forEach(function (cardEl) {
      var d = st.drafts[+cardEl.getAttribute('data-i')]; if (d.status === 'saved') return;
      var t = cardEl.querySelector('.uf-term'), df = cardEl.querySelector('.uf-def'), ci = cardEl.querySelector('.uf-cat');
      t.oninput = function () { d.term = t.value; }; df.oninput = function () { d.definition = df.value; }; ci.oninput = function () { d.cat = ci.value; };
      cardEl.querySelectorAll('.uf-cats .chip').forEach(function (c) { c.onclick = function () { d.cat = c.getAttribute('data-c'); st.cat = d.cat; renderReview(); }; });
      cardEl.querySelector('.uf-add').onclick = function () { add(d); };
      cardEl.querySelector('.uf-del').onclick = function () { if (d.status === 'saving') return; d.status = 'discarded'; st.discarded++; renderReview(); };
    });
    $('ufNew').onclick = function () {
      var pending = st.drafts.filter(function (d) { return d.status === 'draft' || d.status === 'error'; }).length;
      if (pending && !window.confirm('Discard the ' + pending + ' cards you haven’t reviewed?')) return;
      reset(uid()); paint();
    };
  }

  async function add(d) {
    var u = uid(); if (!u) { reset(null); return paint(); }
    if (d.status === 'saving' || d.status === 'saved') return; // double-tap guard
    var v = { subject: catClean(d.cat), term: String(d.term || '').trim(), definition: String(d.definition || '').trim(), source: clip('Made from upload: ' + st.src, 300) };
    if (!v.subject || !v.term || !v.definition) { d.status = 'error'; d.error = 'Front, back and category are required.'; return renderReview(); }
    if (v.subject.length > LIM.subject || v.term.length > LIM.term || v.definition.length > LIM.definition) { d.status = 'error'; d.error = 'Too long — shorten the text.'; return renderReview(); }
    var known = Object.keys(st.mineCats || {}); var mk = v.subject.toLowerCase(); if (st.mineCats && st.mineCats[mk]) v.subject = st.mineCats[mk];
    else PRESETS.forEach(function (p) { if (p.toLowerCase() === mk) v.subject = p; });
    d.status = 'saving'; renderReview();
    try {
      var sb = await XRS.client();
      if (d.retry) { // a previous attempt may have saved before the network dropped: look before inserting again
        var ex = await sb.from('personal_flashcards').select('id').eq('term', v.term).eq('definition', v.definition).limit(1);
        if (!ex.error && ex.data && ex.data.length) { done(d, u, ex.data[0].id, v); return; }
      }
      var r = await sb.from('personal_flashcards').insert(v).select('id').single();
      if (r.error) throw r.error;
      done(d, u, r.data.id, v);
    } catch (e) {
      if (uid() !== u) return;
      d.status = 'error'; d.retry = true;
      var m = (e && e.message) || '';
      d.error = /card_limit/.test(m) ? 'You’ve reached the 2,000-card limit.' : 'Couldn’t save. Check your connection and tap Try again.';
      renderReview();
    }
  }
  function done(d, u, id, v) {
    if (uid() !== u) return;
    d.status = 'saved'; d.savedId = id; d.cat = v.subject; d.term = v.term; d.definition = v.definition; st.saved++;
    if (st.mineNorms) st.mineNorms[norm(v.term)] = v.term;
    if (st.mineCats) st.mineCats[v.subject.toLowerCase()] = st.mineCats[v.subject.toLowerCase()] || v.subject;
    renderReview();
  }

  // Account changes: drafts are private to whoever generated them.
  if (window.XRS && XRS.on) XRS.on(function () {
    var u = uid();
    if (u !== st.uid) { reset(u); if (box() && !box().classList.contains('hidden')) paint(); }
  });
})();
