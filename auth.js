/* XRaySavvy accounts (optional). Shared by index.html and upload.html.
 * - Loads supabase-js v2 lazily from a CDN; if it fails, the site works exactly as before.
 * - Session is kept in localStorage under one key, so both pages share the login (same origin).
 * - window.XRS: { user, client(), log(rows), mark(id, patch), on(cb), openSheet(view), initials() }
 * The publishable key below is PUBLIC by design; Row Level Security limits every user to their own rows.
 */
(function () {
  'use strict';
  var SUPABASE_URL = 'https://fnopntlihakgrydvwdge.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_e59T3yCSuMGmLxunWtdTbw_B1KGGsMs';
  var STORAGE_KEY = 'xraysavvy-auth';
  var QUEUE_KEY = 'xraysavvy.pendingResults.v1';
  var CDNS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm',
    'https://esm.sh/@supabase/supabase-js@2.118.0'
  ];
  var PRIVACY = 'Accounts store only your email, your decks and your quiz results. Never upload patient info.';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }

  // Read the saved session synchronously so quizzes can log right away (confirmed once the client loads).
  function storedUser() {
    try {
      var s = JSON.parse(lsGet(STORAGE_KEY) || 'null');
      var u = s && (s.user || (s.currentSession && s.currentSession.user));
      return u && u.id ? { id: u.id, email: u.email, meta: u.user_metadata || {} } : null;
    } catch (e) { return null; }
  }

  var listeners = [];
  var XRS = window.XRS = {
    user: storedUser(),
    profileName: '',
    PRIVACY: PRIVACY,
    on: function (cb) { listeners.push(cb); },
    client: loadClient,
    log: log,
    mark: mark,
    openSheet: openSheet,
    initials: initials,
    flush: flush
  };
  function emit() { listeners.slice().forEach(function (cb) { try { cb(XRS.user); } catch (e) { console.error(e); } }); renderButton(); }

  // ---------------- client ----------------
  var clientPromise = null;
  function loadClient() {
    if (clientPromise) return clientPromise;
    clientPromise = (async function () {
      var mod = null, lastErr = null;
      for (var i = 0; i < CDNS.length && !mod; i++) {
        try { mod = await import(CDNS[i]); } catch (e) { lastErr = e; }
      }
      if (!mod) throw lastErr || new Error('Could not load login library');
      var sb = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: STORAGE_KEY, storage: window.localStorage },
        // keepalive lets small saves finish even if the page is closed or you tap a link right away
        global: { fetch: function (u, o) { o = o || {}; if (o.method && o.method !== 'GET' && typeof o.body === 'string' && o.body.length < 60000) o = Object.assign({}, o, { keepalive: true }); return fetch(u, o); } }
      });
      sb.auth.onAuthStateChange(function (event, session) {
        var prev = XRS.user && XRS.user.id;
        var u = session && session.user;
        XRS.user = u ? { id: u.id, email: u.email, meta: u.user_metadata || {} } : null;
        if (event === 'PASSWORD_RECOVERY') setTimeout(function () { openSheet('newpass'); }, 0);
        if ((XRS.user && XRS.user.id) !== prev || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
          if (XRS.user) { loadProfile(sb); setTimeout(flush, 300); }
          setTimeout(emit, 0);
        }
      });
      return sb;
    })();
    clientPromise.catch(function (e) { console.warn('[XRS] login unavailable:', e); clientPromise = null; });
    return clientPromise;
  }
  async function loadProfile(sb) {
    try {
      var r = await sb.from('profiles').select('display_name').maybeSingle();
      XRS.profileName = (r.data && r.data.display_name) || (XRS.user && XRS.user.meta.display_name) || '';
      renderButton();
    } catch (e) { }
  }

  // ---------------- result logging (async, never blocks the quiz) ----------------
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function readQ() { try { var q = JSON.parse(lsGet(QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : []; } catch (e) { return []; } }
  function writeQ(q) { lsSet(QUEUE_KEY, JSON.stringify(q.slice(-2000))); }
  var flushTimer = null;
  function cut(v, n) { return v == null ? null : String(v).slice(0, n); }
  // rows: [{source, field, correct, result?, projection?, group_label?, deck_client_id?, deck_name?}]
  // Returns the row ids (or [] when logged out).
  function log(rows) {
    if (!XRS.user) return [];
    var now = new Date().toISOString();
    var q = readQ(), ids = [];
    (Array.isArray(rows) ? rows : [rows]).forEach(function (r) {
      var id = uuid(); ids.push(id);
      q.push({ id: id, user_id: XRS.user.id, source: r.source, field: r.field, correct: !!r.correct, result: r.result || null,
        projection: cut(r.projection, 200), group_label: cut(r.group_label, 200),
        deck_client_id: cut(r.deck_client_id, 100), deck_name: cut(r.deck_name, 200), created_at: now });
    });
    writeQ(q);
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1200);
    return ids;
  }
  // Fix an answer after the fact (e.g. "I was right").
  function mark(id, patch) {
    if (!id || !XRS.user) return;
    var q = readQ(), hit = q.find(function (r) { return r.id === id; });
    if (hit) { Object.assign(hit, patch); writeQ(q); return; }
    loadClient().then(function (sb) { return sb.from('quiz_results').update(patch).eq('id', id); }).catch(function () { });
  }
  var flushing = false;
  async function flush() {
    if (flushing || !XRS.user) return;
    var q = readQ(); if (!q.length) return;
    flushing = true;
    try {
      var sb = await loadClient();
      var s = await sb.auth.getSession();
      var uid = s.data.session && s.data.session.user.id;
      if (!uid) return;
      var mine = q.filter(function (r) { return r.user_id === uid; }).slice(0, 500);
      if (mine.length) {
        var res = await sb.from('quiz_results').insert(mine);
        if (res.error && res.error.code !== '23505') throw res.error; // 23505 = already sent
      }
      var sent = {}; mine.forEach(function (r) { sent[r.id] = 1; });
      writeQ(readQ().filter(function (r) { return !sent[r.id] && r.user_id === uid; }));
      if (readQ().length) setTimeout(flush, 500);
    } catch (e) { console.warn('[XRS] will retry sending results later', e); }
    finally { flushing = false; }
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

  // ---------------- UI: account button + sheet ----------------
  var css = '' +
    '.xrs-acct{background:var(--card,#1a2332);border:1px solid var(--border,#38444d);color:var(--text,#e7e9ea);border-radius:999px;padding:0.35rem 0.8rem;font-size:0.85rem;cursor:pointer;font-family:inherit;white-space:nowrap;min-height:34px}' +
    '.xrs-acct.in{background:var(--accent,#1d9bf0);border-color:var(--accent,#1d9bf0);color:#fff;font-weight:700;min-width:34px;padding:0.35rem 0.6rem}' +
    '.xrs-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:flex-end;justify-content:center}' +
    '.xrs-sheet{background:var(--card,#1a2332);color:var(--text,#e7e9ea);width:100%;max-width:480px;border-radius:16px 16px 0 0;border:1px solid var(--border,#38444d);padding:1rem 1rem calc(1rem + env(safe-area-inset-bottom));max-height:92vh;overflow:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.45}' +
    '@media(min-width:600px){.xrs-ov{align-items:center}.xrs-sheet{border-radius:16px}}' +
    '.xrs-sheet h2{margin:0;font-size:1.15rem}.xrs-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem}' +
    '.xrs-x{background:none;border:none;color:var(--muted,#8b98a5);font-size:1.5rem;cursor:pointer;line-height:1;padding:0.2rem 0.5rem}' +
    '.xrs-seg{display:flex;gap:0.4rem;margin-bottom:0.7rem}.xrs-seg button{flex:1;border:1px solid var(--border,#38444d);background:var(--bg,#0f1419);color:var(--text,#e7e9ea);border-radius:999px;padding:0.5rem;font-size:0.95rem;cursor:pointer;font-family:inherit}' +
    '.xrs-seg button.on{background:var(--accent,#1d9bf0);border-color:var(--accent,#1d9bf0);color:#fff}' +
    '.xrs-sheet label{display:block;color:var(--muted,#8b98a5);font-size:0.85rem;margin:0.55rem 0 0.25rem}' +
    '.xrs-sheet input{width:100%;padding:0.7rem 0.9rem;border-radius:10px;border:1px solid var(--border,#38444d);background:var(--bg,#0f1419);color:var(--text,#e7e9ea);font-size:16px;font-family:inherit;box-sizing:border-box}' +
    '.xrs-go{width:100%;margin-top:0.9rem;padding:0.75rem;border:none;border-radius:10px;background:var(--accent,#1d9bf0);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit}' +
    '.xrs-go.sec{background:#38444d}.xrs-go:disabled{opacity:.6}' +
    '.xrs-link{background:none;border:none;color:var(--accent,#1d9bf0);cursor:pointer;font-size:0.9rem;padding:0.5rem 0;font-family:inherit}' +
    '.xrs-msg{margin-top:0.7rem;padding:0.6rem 0.8rem;border-radius:8px;font-size:0.9rem}.xrs-msg.err{background:#3d1a1c;color:#ff8a92}.xrs-msg.ok{background:#0d3d2e;color:#00ba7c}' +
    '.xrs-note{color:var(--muted,#8b98a5);font-size:0.8rem;margin-top:0.8rem}';
  function addCss() { if (document.getElementById('xrs-css')) return; var s = document.createElement('style'); s.id = 'xrs-css'; s.textContent = css; document.head.appendChild(s); }

  function initials() {
    var u = XRS.user; if (!u) return '';
    var n = (XRS.profileName || (u.meta && u.meta.display_name) || '').trim();
    if (n) { var p = n.split(/\s+/); return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
    return (u.email || '?')[0].toUpperCase();
  }
  function renderButton() {
    var slot = document.getElementById('acct-slot'); if (!slot) return;
    var b = slot.querySelector('.xrs-acct');
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.id = 'acct-btn'; b.className = 'xrs-acct'; b.onclick = function () { openSheet(); }; slot.appendChild(b); }
    if (XRS.user) { b.textContent = initials(); b.classList.add('in'); b.setAttribute('aria-label', 'Account: ' + (XRS.user.email || '')); b.title = XRS.user.email || ''; }
    else { b.textContent = 'Log in'; b.classList.remove('in'); b.setAttribute('aria-label', 'Log in or sign up'); b.title = ''; }
  }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) { if (k === 'onclick') e.onclick = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var ov = null;
  function closeSheet() { if (ov) { ov.remove(); ov = null; document.body.style.overflow = ''; } }
  function pageUrl() { return location.origin + location.pathname; }
  function friendly(err) {
    var m = (err && (err.message || err.error_description)) || String(err || 'Something went wrong');
    var code = err && err.code;
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m) || code === 'email_not_confirmed') return 'Please confirm your email first (check your inbox), then log in.';
    if (/not authorized/i.test(m) || code === 'email_address_not_authorized') return 'Sign-up email could not be sent. The site owner needs to turn off "Confirm email" in Supabase (or set up email sending).';
    if (code === 'email_address_invalid' || /email address .* is invalid/i.test(m)) return 'That email address can\'t be used — please use your real email.';
    if (/rate limit/i.test(m) || code === 'over_email_send_rate_limit') return 'Too many emails sent in the last hour. Please try again later.';
    if (/already registered|already been registered|user_already_exists/i.test(m)) return 'That email already has an account — try Log in.';
    if (/password should be|weak_password/i.test(m)) return 'Password is too short — use at least 6 characters.';
    if (/fetch|network|load/i.test(m)) return 'No connection right now. Try again in a moment.';
    return m;
  }

  function openSheet(view) {
    addCss(); closeSheet();
    view = view || (XRS.user ? 'account' : 'login');
    ov = h('div', { class: 'xrs-ov', role: 'dialog', 'aria-modal': 'true' });
    ov.addEventListener('click', function (e) { if (e.target === ov) closeSheet(); });
    var sheet = h('div', { class: 'xrs-sheet', id: 'xrs-sheet' });
    ov.appendChild(sheet); document.body.appendChild(ov); document.body.style.overflow = 'hidden';
    var titles = { login: 'Log in', signup: 'Create account', forgot: 'Reset password', newpass: 'Set a new password', account: 'Your account' };
    sheet.appendChild(h('div', { class: 'xrs-top' }, [h('h2', { text: titles[view] }), h('button', { class: 'xrs-x', 'aria-label': 'Close', onclick: closeSheet, text: '×' })]));
    var msg = h('div', { class: 'xrs-msg hidden', style: 'display:none' });
    function say(t, ok) { msg.textContent = t; msg.className = 'xrs-msg ' + (ok ? 'ok' : 'err'); msg.style.display = t ? 'block' : 'none'; }

    if (view === 'login' || view === 'signup') {
      sheet.appendChild(h('div', { class: 'xrs-seg' }, [
        h('button', { class: view === 'login' ? 'on' : '', onclick: function () { openSheet('login'); }, text: 'Log in' }),
        h('button', { class: view === 'signup' ? 'on' : '', onclick: function () { openSheet('signup'); }, text: 'Sign up' })]));
      var form = h('form', { id: 'xrs-form', novalidate: '' });
      var name = null;
      if (view === 'signup') { name = h('input', { type: 'text', id: 'xrs-name', autocomplete: 'nickname', maxlength: '60', placeholder: 'e.g. Sam' }); form.appendChild(h('label', { for: 'xrs-name', text: 'Name (optional, shown as your initials)' })); form.appendChild(name); }
      var email = h('input', { type: 'email', id: 'xrs-email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: '' });
      var pass = h('input', { type: 'password', id: 'xrs-pass', autocomplete: view === 'signup' ? 'new-password' : 'current-password', minlength: '6', required: '' });
      form.appendChild(h('label', { for: 'xrs-email', text: 'Email' })); form.appendChild(email);
      form.appendChild(h('label', { for: 'xrs-pass', text: view === 'signup' ? 'Password (at least 6 characters)' : 'Password' })); form.appendChild(pass);
      var go = h('button', { type: 'submit', class: 'xrs-go', id: 'xrs-submit', text: view === 'signup' ? 'Create account' : 'Log in' });
      form.appendChild(go); form.appendChild(msg);
      form.onsubmit = async function (e) {
        e.preventDefault(); say('');
        var em = email.value.trim(), pw = pass.value;
        if (!/^\S+@\S+\.\S+$/.test(em)) return say('Enter a valid email.');
        if (pw.length < 6) return say('Password needs at least 6 characters.');
        go.disabled = true; go.textContent = 'Please wait…';
        try {
          var sb = await loadClient(), r;
          if (view === 'signup') {
            r = await sb.auth.signUp({ email: em, password: pw, options: { emailRedirectTo: pageUrl(), data: name && name.value.trim() ? { display_name: name.value.trim().slice(0, 60) } : {} } });
            if (r.error) throw r.error;
            if (r.data.session) { say('Account created — you\'re logged in!', true); setTimeout(closeSheet, 900); }
            else if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) say('That email already has an account — try Log in.');
            else say('Almost done! Check your email and tap the confirmation link, then log in here.', true);
          } else {
            r = await sb.auth.signInWithPassword({ email: em, password: pw });
            if (r.error) throw r.error;
            say('Logged in!', true); setTimeout(closeSheet, 600);
          }
        } catch (err) { say(friendly(err)); }
        finally { go.disabled = false; go.textContent = view === 'signup' ? 'Create account' : 'Log in'; }
      };
      sheet.appendChild(form);
      if (view === 'login') sheet.appendChild(h('button', { class: 'xrs-link', id: 'xrs-forgot', onclick: function () { openSheet('forgot'); }, text: 'Forgot password?' }));
      sheet.appendChild(h('div', { class: 'xrs-note', text: 'Optional: log in to sync your decks across devices and track your progress. ' + PRIVACY }));
      setTimeout(function () { (name || email).focus(); }, 50);
    } else if (view === 'forgot') {
      var em2 = h('input', { type: 'email', id: 'xrs-email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off' });
      var go2 = h('button', { class: 'xrs-go', text: 'Email me a reset link' });
      go2.onclick = async function () {
        var em = em2.value.trim(); if (!/^\S+@\S+\.\S+$/.test(em)) return say('Enter a valid email.');
        go2.disabled = true;
        try { var sb = await loadClient(); var r = await sb.auth.resetPasswordForEmail(em, { redirectTo: pageUrl() }); if (r.error) throw r.error; say('If that email has an account, a reset link is on its way. Open it on this device.', true); }
        catch (err) { say(friendly(err)); } finally { go2.disabled = false; }
      };
      sheet.appendChild(h('label', { for: 'xrs-email', text: 'Email' })); sheet.appendChild(em2); sheet.appendChild(go2); sheet.appendChild(msg);
      sheet.appendChild(h('button', { class: 'xrs-link', onclick: function () { openSheet('login'); }, text: '← Back to log in' }));
    } else if (view === 'newpass') {
      var np = h('input', { type: 'password', id: 'xrs-pass', autocomplete: 'new-password', minlength: '6' });
      var go3 = h('button', { class: 'xrs-go', text: 'Save new password' });
      go3.onclick = async function () {
        if (np.value.length < 6) return say('Password needs at least 6 characters.');
        go3.disabled = true;
        try { var sb = await loadClient(); var r = await sb.auth.updateUser({ password: np.value }); if (r.error) throw r.error; say('Password updated. You\'re logged in.', true); setTimeout(closeSheet, 1200); }
        catch (err) { say(friendly(err)); } finally { go3.disabled = false; }
      };
      sheet.appendChild(h('label', { for: 'xrs-pass', text: 'New password (at least 6 characters)' })); sheet.appendChild(np); sheet.appendChild(go3); sheet.appendChild(msg);
    } else {
      var u = XRS.user || {};
      sheet.appendChild(h('div', { style: 'display:flex;gap:0.7rem;align-items:center' }, [
        h('div', { class: 'xrs-acct in', style: 'font-size:1rem;min-width:42px;min-height:42px;display:flex;align-items:center;justify-content:center', text: initials() }),
        h('div', {}, [h('div', { style: 'font-weight:600', text: XRS.profileName || 'Logged in' }), h('div', { style: 'color:var(--muted,#8b98a5);font-size:0.9rem;word-break:break-all', id: 'xrs-email-shown', text: u.email || '' })])]));
      sheet.appendChild(h('div', { class: 'xrs-note', text: 'Your decks sync to this account and every answer counts toward your 📊 Progress.' }));
      var onIndex = /index\.html$|\/$/.test(location.pathname);
      sheet.appendChild(h('button', { class: 'xrs-go', onclick: function () { closeSheet(); if (onIndex && window.showProgressTab) window.showProgressTab(); else location.href = './index.html#progress'; }, text: '📊 See my progress' }));
      var out = h('button', { class: 'xrs-go sec', id: 'xrs-logout', text: 'Log out' });
      out.onclick = async function () {
        out.disabled = true;
        try { await flush(); } catch (e) { }
        try { var sb = await loadClient(); await sb.auth.signOut(); } catch (e) { }
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
        XRS.user = null; XRS.profileName = ''; emit(); closeSheet();
      };
      sheet.appendChild(out); sheet.appendChild(msg);
      sheet.appendChild(h('div', { class: 'xrs-note', text: 'Logging out keeps the decks saved on this device. ' + PRIVACY }));
    }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function boot() {
    addCss(); renderButton();
    // Load the library right away only when someone is logged in or arriving from an email link;
    // otherwise wait until the page is idle so logged-out visitors pay nothing up front.
    var fromLink = /access_token=|type=recovery|type=signup|error_description=/.test(location.hash + location.search);
    if (XRS.user || fromLink) loadClient().catch(function () { });
    else setTimeout(function () { loadClient().catch(function () { }); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
