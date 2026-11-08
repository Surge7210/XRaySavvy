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
  function cid(i) { return deck.id + ':' + i + (reverse ? ':r' : ''); }
  function stats(d, rev) {
    var s = load(), now = Date.now(), due = 0, nw = 0;
    d.cards.forEach(function (c, i) { var st = s[d.id + ':' + i + (rev ? ':r' : '')]; if (!st) nw++; else if (st.due <= now) due++; });
    return { due: due, nw: nw };
  }
  function esc(t) { var d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

  function renderHome() {
    deck = null;
    var h = '<h2 class="fc-h">Flashcards</h2><p class="fc-sub">Pick a deck. Your progress is private to you.</p><p class="fc-sync fc-sub" aria-live="polite">' + esc(syncText()) + '</p>';
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
    h += '<p class="fc-note">More subjects (Physics, Patient Care) coming soon.</p>';
    root.innerHTML = h;
    root.querySelectorAll('.fc-study').forEach(function (b) { b.onclick = function () { start(b.getAttribute('data-deck')); }; });
    sync();
  }
  function buildQueue() {
    var s = load(), now = Date.now(), due = [], nw = [];
    deck.cards.forEach(function (c, i) { var st = s[cid(i)]; if (!st) nw.push(i); else if (st.due <= now) due.push(i); });
    due.sort(function (a, b) { return s[cid(a)].due - s[cid(b)].due; });
    for (var i = nw.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = nw[i]; nw[i] = nw[j]; nw[j] = t; }
    queue = due.concat(nw);
  }
  function start(id) {
    deck = DECKS.filter(function (d) { return d.id === id; })[0]; done = 0;
    buildQueue(); next();
  }
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
    root.querySelector('.fc-back').onclick = renderHome;
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
    root.querySelector('.fc-back').onclick = renderHome;
    if (done && typeof window.launchConfetti === 'function') try { window.launchConfetti(); } catch (e) {}
  }
  window.renderFlashcards = function (el) { root = el; renderHome(); };
  // Account changed (sign in / out / switch): progress is namespaced per user id, so just re-read and re-sync.
  if (window.XRS && XRS.on) XRS.on(function () { syncState = 'local'; syncing = null; if (root && !root.closest('.hidden')) { if (deck) renderHome(); else renderHome(); } });
})();
