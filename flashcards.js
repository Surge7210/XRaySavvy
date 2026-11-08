/* XRaySavvy Flashcards (preview). Public reviewed decks; per-student progress stored on THIS device,
   namespaced by signed-in user id (no cloud sync yet). */
(function () {
  var DECKS = [{
    id: 'gi-terms', subject: 'Vocabulary', title: 'GI Terminology',
    blurb: 'Pathophysiology of the GI tract — key terms',
    cards: [
      ["Adenocarcinoma", "A malignant tumor that develops from the glandular tissue of an organ."],
      ["Bacteriolytic", "Relating to the destruction of bacteria."],
      ["Carcinoma", "A malignant tumor that develops from epithelial tissue."],
      ["Chyme", "A mix of partly digested food and gastric juices."],
      ["Constipation", "Difficulty or inability moving the bowels, due to hard or dry stool."],
      ["Crohn's Disease", "A chronic inflammatory condition, typically of the terminal ileum."],
      ["Deglutition", "Swallowing — the act of passing food from the mouth into the upper esophagus."],
      ["Diarrhea", "A GI disturbance with loose, watery stools, which can cause dehydration."],
      ["Diverticulosis", "A colon condition with small sacs (pouches) bulging out from its walls."],
      ["Endoscopy", "A procedure to look inside a body cavity using a fiber-optic scope (usually flexible)."],
      ["Epithelial Tissue", "Tissue that forms the outer cell layer on an organ's surface and lines hollow structures."],
      ["Esophageal Varices", "Twisted, dilated veins around the esophagus, most often from increased portal venous pressure due to cirrhosis of the liver."],
      ["Fistula", "An abnormal connection or passageway between two cavities or organs that are normally separate."],
      ["Heartburn", "An uncomfortable burning feeling in the substernal region, most often from reflux of gastric juices into the esophagus."],
      ["Hiatal Hernia", "The upper portion of the stomach protrudes through the hiatus of the diaphragm."],
      ["Hirschsprung's Disease", "A congenital condition where nerve cells (the nerve plexus) fail to develop in part of the bowel, usually the rectosigmoid region, resulting in a megacolon.", "Class handout note: the handout says “abdominal development”; it means abnormal (missing) nerve development."],
      ["Ileus", "Slowed or stopped intestinal movement (peristalsis) without a physical blockage — often called paralytic ileus.", "Class handout note: the handout defines ileus as the intestine twisting on itself. That twisting is volvulus, not ileus."],
      ["Inguinal Hernia", "A protrusion of an abdominal sac (which may contain intestine) through the inguinal ring."],
      ["Intussusception", "An intestinal obstruction where one part of the intestine slides (telescopes) into an adjacent segment.", "Class handout note: the handout says it slides into a proximal segment. Usually the proximal part slides into the distal part, so remember “adjacent”."],
      ["Laxative", "A medication or food that encourages a bowel movement, for example by softening the stool."],
      ["Lysozyme", "A bacteriolytic enzyme in many body fluids (like tears and saliva) that is a first line of defense against invading bacteria."],
      ["Peptic Ulcer", "Mucosal erosion in the distal esophagus, stomach, or proximal small intestine (duodenum)."],
      ["Peristalsis", "A rhythmic, wave-like contraction that moves contents through hollow tubes like the alimentary (digestive) and urinary tracts."],
      ["Polyp", "A growth from a mucous membrane, often on a stalk, commonly found in the nasal cavity, uterus, or large intestine."],
      ["Pyloric Stenosis", "A thickening around the pyloric sphincter that keeps food from passing into the duodenum."],
      ["Pylorospasm", "A spasm of the pyloric (terminal) portion of the stomach."],
      ["Sigmoidoscopy", "A procedure where a fiber-optic scope (usually flexible) is inserted into the large intestine to examine it."],
      ["Ulcerative Colitis", "An inflammatory condition of the colon with ulcers of the mucosa."],
      ["Volvulus", "A bowel obstruction caused by the intestine twisting on itself."]
    ]
  }];
  window.XRS_FLASH_DECKS = DECKS;

  var DAY = 86400000, MIN = 60000;
  function uid() { return (window.XRS && XRS.user && XRS.user.id) || 'guest'; }
  function key() { return 'xrs-flash-v1:' + uid(); }
  function load() { try { return JSON.parse(localStorage.getItem(key())) || {}; } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(key(), JSON.stringify(s)); } catch (e) {} }
  // Basic spaced repetition. rating: again | hard | good
  function schedule(st, rating, now) {
    st = Object.assign({ ivl: 0, reps: 0, lapses: 0 }, st || {});
    if (rating === 'again') { st.ivl = 0; st.reps = 0; st.lapses++; st.due = now + MIN; }
    else if (rating === 'hard') { st.ivl = Math.max(1, Math.round(st.ivl * 1.2)) || 1; st.reps++; st.due = now + (st.reps === 1 ? 10 * MIN : st.ivl * DAY); }
    else { st.ivl = st.reps === 0 ? 1 : st.reps === 1 ? 3 : Math.round(Math.max(st.ivl, 1) * 2.5); st.reps++; st.due = now + st.ivl * DAY; }
    st.last = rating; st.seen = now;
    return st;
  }
  // ---- Private cross-device sync (signed-in only). Newest review per card wins, locally and on the server. ----
  var syncState = 'local', syncing = null;
  function slim(st) { return { ivl: st.ivl, reps: st.reps, lapses: st.lapses, due: st.due, last: st.last, seen: st.seen }; }
  function rowOf(u, k, st) { return { user_id: u, card_key: k, state: slim(st), reviewed_at: new Date(st.seen).toISOString() }; }
  function merge(local, rows) {
    var push = [], seenRemote = {};
    rows.forEach(function (r) {
      var t = Date.parse(r.reviewed_at), st = local[r.card_key];
      seenRemote[r.card_key] = t;
      if (!st || !(st.seen >= t)) { var n = Object.assign({}, r.state); n.seen = t; local[r.card_key] = n; }
    });
    Object.keys(local).forEach(function (k) { var st = local[k]; if (st && st.seen && !(seenRemote[k] >= st.seen)) push.push(k); });
    return push;
  }
  function sync() {
    var u = window.XRS && XRS.user && XRS.user.id;
    if (!u) { syncState = 'local'; return Promise.resolve(); }
    if (syncing) return syncing;
    syncState = 'syncing';
    syncing = XRS.client().then(function (sb) {
      return sb.from('flashcard_progress').select('card_key,state,reviewed_at').limit(20000).then(function (res) {
        if (res.error) throw res.error;
        if (!XRS.user || XRS.user.id !== u) return; // signed out / switched mid-sync: discard
        var local = load(), push = merge(local, res.data || []); save(local);
        if (!push.length) return;
        var rows = push.map(function (k) { return rowOf(u, k, local[k]); });
        return sb.from('flashcard_progress').upsert(rows, { onConflict: 'user_id,card_key' }).then(function (r2) { if (r2.error) throw r2.error; });
      });
    }).then(function () { syncState = (window.XRS && XRS.user && XRS.user.id === u) ? 'synced' : 'local'; },
            function (e) { console.warn('flashcard sync', e); syncState = 'error'; })
      .then(function () { syncing = null; paintSync(); });
    return syncing;
  }
  function pushOne(k, st) {
    var u = window.XRS && XRS.user && XRS.user.id; if (!u) return;
    XRS.client().then(function (sb) { return sb.from('flashcard_progress').upsert([rowOf(u, k, st)], { onConflict: 'user_id,card_key' }); })
      .then(function (r) { if (r && r.error) throw r.error; syncState = 'synced'; paintSync(); }, function () { syncState = 'error'; paintSync(); })
      .catch(function () { syncState = 'error'; paintSync(); });
  }
  function syncText() {
    if (!(window.XRS && XRS.user)) return 'Saved on this device. Log in to sync across your devices.';
    return syncState === 'synced' ? 'Synced privately to your account.' : syncState === 'error' ? 'Saved on this device — will sync when back online.' : 'Syncing…';
  }
  function paintSync() { var el = root && root.querySelector('.fc-sync'); if (el) el.textContent = syncText(); if (root && !deck && syncState === 'synced') refreshCounts(); }
  function refreshCounts() { if (!root) return; root.querySelectorAll('[data-count]').forEach(function (el) { var d = DECKS.filter(function (x) { return x.id === el.getAttribute('data-count'); })[0]; if (d) { var s = stats(d, false); el.textContent = d.cards.length + ' cards · ' + s.nw + ' new · ' + s.due + ' due'; } }); }
  window.addEventListener('online', function () { if (window.XRS && XRS.user) sync(); });
  window.XRS_FLASH = { schedule: schedule, key: key, merge: merge, sync: sync, state: function () { return syncState; } };

  var root, deck, reverse = false, queue = [], cur = null, shown = false, done = 0;
  function ckey(d, i, rev) { var c = d.cards[i]; return d.id + ':' + (c[3] || i) + (rev ? ':r' : ''); }
  function cid(i) { return ckey(deck, i, reverse); }
  function stats(d, rev) {
    var s = load(), now = Date.now(), due = 0, nw = 0;
    d.cards.forEach(function (c, i) { var st = s[ckey(d, i, rev)]; if (!st) nw++; else if (st.due <= now) due++; });
    return { due: due, nw: nw };
  }
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function renderHome() {
    deck = null;
    var h = '<h2 class="fc-h">Flashcards</h2><p class="fc-sub">Pick a deck. Your progress is private to you.</p><p class="fc-sync fc-sub" aria-live="polite">' + esc(syncText()) + '</p>' + makeCta();
    var subs = {};
    DECKS.forEach(function (d) { (subs[d.subject] = subs[d.subject] || []).push(d); });
    Object.keys(subs).forEach(function (sub) {
      h += '<h3 class="fc-subject">' + esc(sub) + '</h3>';
      subs[sub].forEach(function (d) {
        var s = stats(d, false);
        h += '<div class="quiz-box fc-deck"><div class="fc-deck-t">' + esc(d.title) + '</div><div class="fc-deck-b">' + esc(d.blurb) + '</div>' +
          '<div class="fc-deck-n" data-count="' + d.id + '">' + d.cards.length + ' cards · ' + s.nw + ' new · ' + s.due + ' due</div>' +
          '<button class="btn-primary fc-study" data-deck="' + d.id + '" type="button">Study</button></div>';
      });
    });
    if (community.cards.length) {
      var cs = {};
      community.cards.forEach(function (c) { (cs[c.subject] = cs[c.subject] || []).push(c); });
      h += '<h3 class="fc-subject">Community cards</h3><p class="fc-sub">Suggested by students, reviewed by XRaySavvy.</p>';
      Object.keys(cs).sort().forEach(function (sub) {
        h += '<div class="quiz-box fc-deck"><div class="fc-deck-t">' + esc(sub) + '</div><div class="fc-deck-n">' + cs[sub].length + ' cards</div>' +
          '<button class="btn-primary fc-study" data-community="' + esc(sub) + '" type="button">Study</button></div>';
      });
    }
    h += '<p class="fc-note">More subjects (Physics, Patient Care) coming soon.</p>';
    root.innerHTML = h;
    root.querySelectorAll('.fc-study').forEach(function (b) { b.onclick = function () {
      var cm = b.getAttribute('data-community');
      if (cm != null) return startDeck(communityDeck(cm));
      start(b.getAttribute('data-deck')); }; });
    var mk = root.querySelector('.fc-make');
    if (mk) mk.onclick = function () { renderMine(); };
    root.querySelectorAll('.fc-auth').forEach(function (b) { b.onclick = function () { if (window.XRS && XRS.openAuth) XRS.openAuth(b.getAttribute('data-mode')); }; });
    if (!community.loaded) loadCommunity();
    sync();
  }
  function buildQueue() {
    var s = load(), now = Date.now(), due = [], nw = [];
    deck.cards.forEach(function (c, i) { var st = s[cid(i)]; if (!st) nw.push(i); else if (st.due <= now) due.push(i); });
    due.sort(function (a, b) { return s[cid(a)].due - s[cid(b)].due; });
    for (var i = nw.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = nw[i]; nw[i] = nw[j]; nw[j] = t; }
    queue = due.concat(nw);
  }
  function start(id) { startDeck(DECKS.filter(function (d) { return d.id === id; })[0]); }
  function startDeck(d) {
    if (!d || !d.cards.length) return renderHome();
    deck = d; done = 0; buildQueue(); next();
  }
  function goBack() { if (deck && deck.back) { var b = deck.back; deck = null; b(); } else renderHome(); }

  // ---- Make your own cards (signed-in only; private; saved to the account) ----
  var LIM = { subject: 60, term: 120, definition: 1000, source: 300 };
  var mine = { uid: null, cards: [], subs: {}, loaded: false, loading: false, error: '' };
  var community = { cards: [], loaded: false };
  function curUid() { return (window.XRS && XRS.user && XRS.user.id) || null; }
  function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/(\w{3,})(es|s)$/, '$1'); }
  function makeCta() {
    if (!curUid()) return '<div class="quiz-box fc-make-box"><div class="fc-deck-t">✍️ Make your own cards</div>' +
      '<div class="fc-deck-b">Create private flashcards that save to your profile and sync across your devices. Free account required.</div>' +
      '<div class="fc-make-act"><button class="btn-primary fc-auth" data-mode="signup" type="button">Sign up free</button>' +
      '<button class="btn-secondary fc-auth" data-mode="login" type="button">Log in</button></div></div>';
    var n = mine.uid === curUid() && mine.loaded ? ' (' + mine.cards.length + ')' : '';
    return '<div class="quiz-box fc-make-box"><div class="fc-deck-t">✍️ Make your own cards</div>' +
      '<div class="fc-deck-b">Your personal cards are private to your account.</div>' +
      '<div class="fc-make-act"><button class="btn-primary fc-make" type="button">My Flashcards' + n + '</button></div></div>';
  }
  function loadCommunity() {
    if (!(window.XRS && XRS.client)) return;
    community.loaded = true;
    XRS.client().then(function (sb) { return sb.from('community_flashcards').select('id,subject,term,definition,source').order('subject').limit(2000); })
      .then(function (r) { if (r.error) throw r.error; community.cards = r.data || []; if (root && !deck && community.cards.length && root.querySelector('.fc-make-box') && !root.querySelector('.fc-mine')) renderHome(); })
      .catch(function () { community.loaded = false; });
  }
  function communityDeck(sub) {
    return { id: 'community', title: sub, cards: community.cards.filter(function (c) { return c.subject === sub; })
      .map(function (c) { return [c.term, c.definition, c.source ? 'Source: ' + c.source : '', c.id]; }) };
  }
  function loadMine(force) {
    var u = curUid();
    if (!u) return Promise.resolve();
    if (mine.uid !== u) mine = { uid: u, cards: [], subs: {}, loaded: false, loading: false, error: '' };
    if (mine.loaded && !force) return Promise.resolve();
    mine.loading = true; mine.error = '';
    return XRS.client().then(function (sb) {
      return Promise.all([
        sb.from('personal_flashcards').select('id,subject,term,definition,source,updated_at').order('created_at').limit(2000),
        sb.from('flashcard_suggestions').select('personal_card_id,status,created_at,owner_note').order('created_at', { ascending: false }).limit(1000)
      ]);
    }).then(function (rs) {
      if (curUid() !== u) return; // account changed mid-load: drop
      if (rs[0].error) throw rs[0].error;
      mine.cards = rs[0].data || []; mine.subs = {};
      (rs[1].data || []).forEach(function (x) { if (x.personal_card_id && !mine.subs[x.personal_card_id]) mine.subs[x.personal_card_id] = x; });
      mine.loaded = true;
    }).catch(function (e) { if (curUid() === u) mine.error = (e && e.message) || 'Could not load your cards.'; })
      .then(function () { if (curUid() === u) mine.loading = false; });
  }
  function bar(title) {
    return '<div class="fc-bar"><button class="btn-secondary fc-back" type="button">‹ Decks</button><span class="fc-left">' + esc(title) + '</span></div>';
  }
  function renderMine() {
    deck = null;
    var u = curUid();
    if (!u) return renderHome();
    if (!mine.loaded || mine.uid !== u) {
      root.innerHTML = bar('My Flashcards') + '<div class="quiz-box fc-mine">' + (mine.error && mine.uid === u ?
        '<p class="fc-err" role="alert">Couldn’t load your cards. ' + esc(mine.error) + '</p><button class="btn-primary fc-retry" type="button">Try again</button>' :
        '<p class="fc-sub">Loading your cards…</p>') + '</div>';
      root.querySelector('.fc-back').onclick = renderHome;
      var rt = root.querySelector('.fc-retry');
      if (rt) rt.onclick = function () { mine.error = ''; renderMine(); };
      else loadMine().then(function () { if (curUid() === u && root.querySelector('.fc-mine')) renderMine(); });
      return;
    }
    var bySub = {};
    mine.cards.forEach(function (c) { (bySub[c.subject] = bySub[c.subject] || []).push(c); });
    var h = bar('My Flashcards') + '<div class="fc-mine">' +
      '<div class="fc-make-act"><button class="btn-primary fc-new" type="button">+ New card</button>' +
      (mine.cards.length ? '<button class="btn-secondary fc-study-mine" data-sub="" type="button">Study all (' + mine.cards.length + ')</button>' : '') + '</div>';
    if (!mine.cards.length) h += '<div class="quiz-box"><p>You don’t have any cards yet.</p><p class="fc-sub">Tap “+ New card” to add a term and definition. Your cards are private to your account.</p></div>';
    Object.keys(bySub).sort().forEach(function (sub) {
      h += '<h3 class="fc-subject">' + esc(sub) + ' <button class="fc-link fc-study-mine" data-sub="' + esc(sub) + '" type="button">Study ' + bySub[sub].length + '</button></h3>';
      bySub[sub].forEach(function (c) {
        var st = mine.subs[c.id], badge = st ? '<span class="fc-badge fc-b-' + esc(st.status) + '">' + esc({ pending: 'Submitted · in review', approved: 'Approved ✓', rejected: 'Not added', merged: 'Already covered' }[st.status] || st.status) + '</span>' : '';
        h += '<div class="quiz-box fc-item"><div class="fc-item-t">' + esc(c.term) + ' ' + badge + '</div><div class="fc-item-d">' + esc(c.definition) + '</div>' +
          (c.source ? '<div class="fc-sub">Source: ' + esc(c.source) + '</div>' : '') +
          (st && st.owner_note ? '<div class="fc-sub">Reviewer note: ' + esc(st.owner_note) + '</div>' : '') +
          '<div class="fc-item-act"><button class="fc-link fc-edit" data-id="' + c.id + '" type="button">Edit</button>' +
          '<button class="fc-link fc-del" data-id="' + c.id + '" type="button">Delete</button>' +
          (st && st.status === 'pending' ? '' : '<button class="fc-link fc-submit" data-id="' + c.id + '" type="button">Submit to XRaySavvy</button>') + '</div></div>';
      });
    });
    h += '<p class="fc-note">Submitting sends a copy of the card for review. It only becomes public if XRaySavvy approves it; later edits to your card don’t change the submitted copy.</p></div>';
    root.innerHTML = h;
    root.querySelector('.fc-back').onclick = renderHome;
    root.querySelector('.fc-new').onclick = function () { renderEditor(null); };
    root.querySelectorAll('.fc-study-mine').forEach(function (b) { b.onclick = function () {
      var sub = b.getAttribute('data-sub');
      var cards = mine.cards.filter(function (c) { return !sub || c.subject === sub; }).map(function (c) { return [c.term, c.definition, '', c.id]; });
      startDeck({ id: 'my', title: sub || 'My cards', cards: cards, back: renderMine }); }; });
    root.querySelectorAll('.fc-edit').forEach(function (b) { b.onclick = function () { renderEditor(findMine(b.getAttribute('data-id'))); }; });
    root.querySelectorAll('.fc-del').forEach(function (b) { b.onclick = function () { delMine(findMine(b.getAttribute('data-id'))); }; });
    root.querySelectorAll('.fc-submit').forEach(function (b) { b.onclick = function () { renderSubmit(findMine(b.getAttribute('data-id'))); }; });
  }
  function findMine(id) { return mine.cards.filter(function (c) { return c.id === id; })[0]; }
  function field(id, label, val, max, area, list) {
    return '<label class="fc-lab" for="' + id + '">' + label + '</label>' + (area ?
      '<textarea id="' + id + '" class="fc-in" maxlength="' + max + '" rows="4">' + esc(val || '') + '</textarea>' :
      '<input id="' + id + '" class="fc-in" maxlength="' + max + '" value="' + esc(val || '') + '"' + (list ? ' list="' + list + '"' : '') + ' autocomplete="off">');
  }
  function renderEditor(c) {
    var u = curUid(); if (!u) return renderHome();
    var subjects = {}; mine.cards.forEach(function (x) { subjects[x.subject] = 1; }); ['Vocabulary', 'Physics', 'Patient Care', 'Anatomy & Positioning', 'Radiation Protection'].forEach(function (x) { subjects[x] = 1; });
    root.innerHTML = bar(c ? 'Edit card' : 'New card') + '<form class="quiz-box fc-form" novalidate>' +
      field('fc-subj', 'Subject', c ? c.subject : 'Vocabulary', LIM.subject, false, 'fc-subj-list') +
      '<datalist id="fc-subj-list">' + Object.keys(subjects).sort().map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist>' +
      field('fc-term', 'Term (front)', c && c.term, LIM.term) +
      field('fc-def', 'Definition (back)', c && c.definition, LIM.definition, true) +
      field('fc-src', 'Source (optional — e.g. class handout, textbook chapter)', c && c.source, LIM.source) +
      '<p class="fc-err hidden" role="alert"></p>' +
      '<div class="fc-make-act"><button class="btn-primary fc-save" type="submit">Save card</button><button class="btn-secondary fc-cancel" type="button">Cancel</button></div></form>';
    root.querySelector('.fc-back').onclick = renderHome;
    root.querySelector('.fc-cancel').onclick = renderMine;
    root.querySelector('.fc-form').onsubmit = function (e) {
      e.preventDefault();
      var v = { subject: val('fc-subj'), term: val('fc-term'), definition: val('fc-def'), source: val('fc-src') || null };
      var err = root.querySelector('.fc-err'), btn = root.querySelector('.fc-save');
      if (!v.subject || !v.term || !v.definition) { err.textContent = 'Subject, term and definition are required.'; err.classList.remove('hidden'); return; }
      if (curUid() !== u) return renderHome();
      btn.disabled = true; btn.textContent = 'Saving…';
      XRS.client().then(function (sb) {
        return c ? sb.from('personal_flashcards').update(v).eq('id', c.id).select('id,subject,term,definition,source,updated_at').single()
                 : sb.from('personal_flashcards').insert(v).select('id,subject,term,definition,source,updated_at').single();
      }).then(function (r) {
        if (r.error) throw r.error;
        if (curUid() !== u) return renderHome();
        if (c) Object.assign(c, r.data); else mine.cards.push(r.data);
        renderMine();
      }).catch(function (e2) {
        if (curUid() !== u) return renderHome();
        btn.disabled = false; btn.textContent = 'Try again';
        err.textContent = 'Couldn’t save. Check your connection and try again. ' + ((e2 && e2.message) || ''); err.classList.remove('hidden');
      });
    };
  }
  function val(id) { var el = root.querySelector('#' + id); return el ? el.value.trim() : ''; }
  function delMine(c) {
    var u = curUid(); if (!c || !u) return;
    if (!window.confirm('Delete “' + c.term + '”? This can’t be undone.')) return;
    XRS.client().then(function (sb) { return sb.from('personal_flashcards').delete().eq('id', c.id); })
      .then(function (r) { if (r.error) throw r.error; if (curUid() !== u) return; mine.cards = mine.cards.filter(function (x) { return x.id !== c.id; }); renderMine(); })
      .catch(function () { window.alert('Couldn’t delete. Please try again.'); });
  }
  function renderSubmit(c) {
    var u = curUid(); if (!c || !u) return;
    var n = norm(c.term), warn = [], exact = false;
    DECKS.concat([{ title: 'Community', cards: community.cards.map(function (x) { return [x.term]; }) }]).forEach(function (d) {
      d.cards.forEach(function (x) { var m = norm(x[0]); if (!m) return;
        if (m === n) { exact = true; warn.push('“' + x[0] + '” is already in ' + d.title + '.'); }
        else if (n.length >= 4 && (m.indexOf(n) >= 0 || n.indexOf(m) >= 0)) warn.push('Similar card: “' + x[0] + '” (' + d.title + ').'); });
    });
    root.innerHTML = bar('Submit to XRaySavvy') + '<div class="quiz-box fc-sub-box"><div class="fc-item-t">' + esc(c.term) + '</div><div class="fc-item-d">' + esc(c.definition) + '</div>' +
      (c.source ? '<div class="fc-sub">Source: ' + esc(c.source) + '</div>' : '<div class="fc-sub">Tip: adding a source helps the reviewer check accuracy.</div>') +
      '<div class="fc-checks" aria-live="polite">Checking for duplicates…</div>' +
      '<p class="fc-sub">XRaySavvy reviews every suggestion for accuracy before it’s public. Duplicate checks are automatic but are not a guarantee the definition is correct.</p>' +
      '<p class="fc-err hidden" role="alert"></p>' +
      '<div class="fc-make-act"><button class="btn-primary fc-send" type="button" disabled>Submit for review</button><button class="btn-secondary fc-cancel" type="button">Cancel</button></div></div>';
    root.querySelector('.fc-back').onclick = renderHome;
    root.querySelector('.fc-cancel').onclick = renderMine;
    var checks = root.querySelector('.fc-checks'), send = root.querySelector('.fc-send'), err = root.querySelector('.fc-err');
    XRS.client().then(function (sb) { return sb.rpc('flashcard_duplicate_check', { p_term: c.term }); }).then(function (r) {
      if (curUid() !== u) return renderHome();
      var d = (r && r.data) || {};
      (d.published || []).forEach(function (x) { if (x.exact) exact = true; warn.push((x.exact ? '“' : 'Similar card: “') + x.term + '”' + (x.exact ? ' is already a community card.' : ' (community).')); });
      if (d.own_pending) { exact = true; warn.push('You already submitted this term and it’s waiting for review.'); }
      if (d.pending_elsewhere) warn.push('Someone else has already suggested this term; it’s waiting for review.');
      paint();
    }, function () { warn.push('Couldn’t reach the server duplicate check; the reviewer will still check.'); paint(); });
    function paint() {
      checks.innerHTML = warn.length ? '<ul class="fc-warn">' + warn.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '<p class="fc-ok">✓ No duplicates found.</p>';
      send.disabled = exact; if (exact) send.textContent = 'Already exists';
    }
    send.onclick = function () {
      send.disabled = true; send.textContent = 'Submitting…';
      XRS.client().then(function (sb) { return sb.from('flashcard_suggestions').insert({ personal_card_id: c.id, subject: c.subject, term: c.term, definition: c.definition, source: c.source || null }); })
        .then(function (r) { if (r.error) throw r.error; if (curUid() !== u) return renderHome(); mine.subs[c.id] = { status: 'pending' }; renderMine(); })
        .catch(function (e) { if (curUid() !== u) return renderHome(); send.disabled = false; send.textContent = 'Try again';
          var m = (e && e.message) || ''; err.textContent = /suggest_dup/.test(m) ? 'You already submitted this term.' : /suggest_rate/.test(m) ? 'Daily limit reached. Try again tomorrow.' : 'Couldn’t submit. Please try again.'; err.classList.remove('hidden'); });
    };
  }
  window.XRS_FLASH_MINE = { norm: norm, state: function () { return mine; } };
  function next() {
    shown = false; cur = queue.shift();
    if (cur == null) return renderDone();
    renderCard();
  }
  function renderCard() {
    var c = deck.cards[cur], front = reverse ? c[1] : c[0], back = reverse ? c[0] : c[1];
    root.innerHTML =
      '<div class="fc-bar"><button class="btn-secondary fc-back" type="button">‹ Decks</button>' +
      '<span class="fc-left" aria-live="polite">' + (queue.length + 1) + ' left</span>' +
      '<button class="btn-secondary fc-rev" type="button" aria-pressed="' + reverse + '">' + (reverse ? 'Definition → Term' : 'Term → Definition') + '</button></div>' +
      '<button class="quiz-box fc-card" type="button" aria-label="Flashcard. Tap to reveal answer">' +
      '<div class="fc-front' + (reverse ? ' fc-small' : '') + '">' + esc(front) + '</div>' +
      '<div class="fc-ans' + (shown ? '' : ' hidden') + '"><hr><div class="' + (reverse ? '' : 'fc-small') + '">' + esc(back) + '</div>' +
      (c[2] ? '<p class="fc-note-cls" role="note">' + esc(c[2]) + '</p>' : '') + '</div>' +
      (shown ? '' : '<div class="fc-tap">Tap to reveal</div>') + '</button>' +
      '<div class="fc-rate' + (shown ? '' : ' hidden') + '">' +
      '<button class="fc-r fc-again" data-r="again" type="button">Again</button>' +
      '<button class="fc-r fc-hard" data-r="hard" type="button">Hard</button>' +
      '<button class="fc-r fc-good" data-r="good" type="button">Got it</button></div>';
    root.querySelector('.fc-back').onclick = goBack;
    root.querySelector('.fc-rev').onclick = function () { reverse = !reverse; buildQueue(); next(); };
    root.querySelector('.fc-card').onclick = function () { if (!shown) { shown = true; renderCard(); var r = root.querySelector('.fc-good'); if (r) r.focus(); } };
    root.querySelectorAll('.fc-r').forEach(function (b) { b.onclick = function () { rate(b.getAttribute('data-r')); }; });
  }
  function rate(r) {
    var s = load(), k = cid(cur);
    s[k] = schedule(s[k], r, Date.now()); save(s); pushOne(k, s[k]);
    if (r === 'good' && typeof window.launchConfetti === 'function') try { window.launchConfetti(); } catch (e) {}
    if (r === 'again') queue.splice(Math.min(3, queue.length), 0, cur); else done++;
    next();
  }
  function renderDone() {
    root.innerHTML = '<div class="quiz-box"><h2 class="fd-title">Deck done for now 🎉</h2><p>' + done + ' cards reviewed. Come back later for cards that are due.</p>' +
      '<div class="fd-actions"><button class="btn-primary fc-back" type="button">Back to decks</button></div></div>';
    root.querySelector('.fc-back').onclick = goBack;
    if (done && typeof window.launchConfetti === 'function') try { window.launchConfetti(); } catch (e) {}
  }
  window.renderFlashcards = function (el) { root = el; renderHome(); };
  // Account changed (sign in / out / switch): progress is namespaced per user id, so just re-read and re-sync.
  var lastAuthUid = curUid();
  if (window.XRS && XRS.on) XRS.on(function () {
    var u = curUid(); syncState = 'local'; syncing = null;
    if (u === lastAuthUid) { if (root && !deck && root.querySelector('.fc-make-box')) renderHome(); return; }
    lastAuthUid = u; mine = { uid: null, cards: [], subs: {}, loaded: false, loading: false, error: '' };
    if (root && !root.closest('.hidden')) { deck = null; renderHome(); }
  });
})();
