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
  var OWNER_ID = 'd08e9b9c-3e14-45f5-8ad0-44df864ff0ee'; // shows the discreet Usage link; not a secret
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

  // Remember how we arrived (email links) before supabase-js tidies the URL.
  var ARRIVAL = (function () {
    var q = new URLSearchParams(location.search), hsh = new URLSearchParams(location.hash.replace(/^#/, ''));
    function g(k) { return q.get(k) || hsh.get(k) || ''; }
    return { tokenHash: q.get('token_hash') || '', type: g('type'), implicit: !!hsh.get('access_token'),
      error: g('error_description') || g('error'), errorCode: g('error_code') };
  })();

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
    flush: flush,
    openAuth: openAuth,
    nudge: nudge,
    nudgeAllowed: nudgeAllowed
  };
  function emit() { if (XRS.user) { markHasAccount(); hideNudge(); } listeners.slice().forEach(function (cb) { try { cb(XRS.user); } catch (e) { console.error(e); } }); renderButton(); }

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
      handleArrival(sb);
      return sb;
    })();
    clientPromise.catch(function (e) { console.warn('[XRS] login unavailable:', e); clientPromise = null; });
    return clientPromise;
  }
  // Email links: ?token_hash=...&type=signup|recovery|email_change|magiclink|invite|email (preferred, set in the
  // Supabase email templates) or the default #access_token=...&type=... links (handled by supabase-js itself).
  var arrivalDone = false;
  function cleanUrl() {
    try {
      var u = new URL(location.href);
      ['token_hash', 'type', 'error', 'error_code', 'error_description', 'next'].forEach(function (k) { u.searchParams.delete(k); });
      if (/access_token=|error_description=|error=/.test(u.hash)) u.hash = '';
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { }
  }
  var DONE_MSG = { signup: 'Email confirmed — you\'re logged in! 🎉', email: 'Email confirmed — you\'re logged in! 🎉', invite: 'Welcome — you\'re logged in! 🎉',
    magiclink: 'You\'re logged in! 🎉', email_change: 'Your email address was updated.' };
  async function handleArrival(sb) {
    if (arrivalDone) return; arrivalDone = true;
    var a = ARRIVAL;
    if (a.error) {
      cleanUrl();
      var expired = /expired|invalid|otp_expired/i.test(a.error + ' ' + a.errorCode);
      return notice('Link problem', expired ? 'That email link has expired or was already used. Request a new one below.' : a.error, false, true);
    }
    if (a.tokenHash && a.type) {
      try {
        var r = await sb.auth.verifyOtp({ token_hash: a.tokenHash, type: a.type });
        cleanUrl();
        if (r.error) throw r.error;
        if (a.type === 'recovery') openSheet('newpass');
        else notice('All set', DONE_MSG[a.type] || 'Done — you\'re logged in!', true);
      } catch (err) {
        cleanUrl();
        notice('Link problem', /expired|invalid|otp/i.test((err && (err.code || '')) + ' ' + (err && err.message)) ? 'That email link has expired or was already used. Request a new one below.' : friendly(err), false, true);
      }
      return;
    }
    if (a.implicit) {
      // supabase-js reads the #access_token itself; just greet the user once the session is in.
      try { await sb.auth.getSession(); } catch (e) { }
      if (a.type === 'recovery') { if (!document.getElementById('xrs-newpass')) openSheet('newpass'); }
      else if (DONE_MSG[a.type] && XRS.user) notice('All set', DONE_MSG[a.type], true);
    }
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
    '.xrs-note{color:var(--muted,#8b98a5);font-size:0.8rem;margin-top:0.8rem}' +
    '.xrs-nudge{position:relative;margin:0.8rem 0 0;padding:0.8rem 2.2rem 0.8rem 0.9rem;border-radius:12px;background:var(--card,#1a2332);border:1px solid var(--border,#38444d);border-left:4px solid var(--accent,#1d9bf0);color:var(--text,#e7e9ea);font-size:0.95rem;line-height:1.4;text-align:left;animation:xrs-in .25s ease-out}' +
    '.xrs-nudge p{margin:0 0 0.65rem}.xrs-nudge-row{display:flex;gap:0.5rem;flex-wrap:wrap}' +
    '.xrs-nudge-row button{min-height:40px;padding:0.5rem 1rem;border-radius:999px;font-size:0.92rem;font-weight:600;cursor:pointer;font-family:inherit}' +
    '.xrs-nudge-go{background:var(--accent,#1d9bf0);border:1px solid var(--accent,#1d9bf0);color:#fff}' +
    '.xrs-nudge-later{background:none;border:1px solid var(--border,#38444d);color:var(--muted,#8b98a5)}' +
    '.xrs-nudge-x{position:absolute;top:0.3rem;right:0.35rem;background:none;border:none;color:var(--muted,#8b98a5);font-size:1.3rem;line-height:1;cursor:pointer;padding:0.3rem 0.45rem}' +
    '@keyframes xrs-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion:reduce){.xrs-nudge{animation:none}}';
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
    if (/not authorized/i.test(m) || code === 'email_address_not_authorized') return 'We couldn\'t send an email to that address right now. Please try again later.';
    if (code === 'email_address_invalid' || /email address .* is invalid/i.test(m)) return 'That email address can\'t be used — please use your real email.';
    if (/rate limit/i.test(m) || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return 'Too many emails sent recently. Please wait a minute and try again.';
    if (/error sending/i.test(m)) return 'We couldn\'t send the email right now. Please try again in a few minutes.';
    if (code === 'same_password' || /should be different/i.test(m)) return 'Pick a password different from your old one.';
    if (/already registered|already been registered|user_already_exists/i.test(m)) return 'That email already has an account — try Log in.';
    if (/password should be|weak_password/i.test(m)) return 'Password is too short — use at least 6 characters.';
    if (/fetch|network|load/i.test(m)) return 'No connection right now. Try again in a moment.';
    return m;
  }

  function notice(title, text, ok, offerReset) { openSheet('notice', { title: title, text: text, ok: ok, offerReset: offerReset }); }
  function openSheet(view, opts) {
    addCss(); closeSheet();
    view = view || (XRS.user ? 'account' : 'login');
    ov = h('div', { class: 'xrs-ov', role: 'dialog', 'aria-modal': 'true' });
    ov.addEventListener('click', function (e) { if (e.target === ov) closeSheet(); });
    var sheet = h('div', { class: 'xrs-sheet', id: 'xrs-sheet' });
    ov.appendChild(sheet); document.body.appendChild(ov); document.body.style.overflow = 'hidden';
    var titles = { login: 'Log in', signup: 'Create account', forgot: 'Reset password', newpass: 'Set a new password', account: 'Your account', notice: (opts && opts.title) || 'XRaySavvy' };
    sheet.appendChild(h('div', { class: 'xrs-top' }, [h('h2', { text: titles[view] }), h('button', { class: 'xrs-x', 'aria-label': 'Close', onclick: closeSheet, text: '×' })]));
    var msg = h('div', { class: 'xrs-msg hidden', style: 'display:none' });
    function say(t, ok) { msg.textContent = t; msg.className = 'xrs-msg ' + (ok ? 'ok' : 'err'); msg.style.display = t ? 'block' : 'none'; }

    if (view === 'notice') {
      sheet.appendChild(msg); say(opts.text, opts.ok);
      if (opts.offerReset) {
        sheet.appendChild(h('button', { class: 'xrs-go', onclick: function () { openSheet('forgot'); }, text: 'Email me a new reset link' }));
        sheet.appendChild(h('button', { class: 'xrs-go sec', onclick: function () { openSheet('login'); }, text: 'Log in' }));
      } else sheet.appendChild(h('button', { class: 'xrs-go', id: 'xrs-ok', onclick: closeSheet, text: 'OK' }));
      return;
    }
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
            if (r.data.user) markHasAccount();
            if (r.data.session) { say('Account created — you\'re logged in!', true); setTimeout(closeSheet, 900); }
            else if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) say('That email already has an account — try Log in.');
            else { say('Almost done! We emailed a confirmation link to ' + em + '. Tap it (check spam too) and you\'ll be logged in.', true); form.querySelectorAll('input').forEach(function (i) { i.disabled = true; }); go.style.display = 'none'; }
          } else {
            r = await sb.auth.signInWithPassword({ email: em, password: pw });
            if (r.error && (r.error.code === 'email_not_confirmed' || /email not confirmed/i.test(r.error.message || ''))) {
              say(friendly(r.error));
              var again = h('button', { type: 'button', class: 'xrs-go sec', id: 'xrs-resend', text: 'Resend confirmation email' });
              again.onclick = async function () {
                again.disabled = true;
                try { var rr = await sb.auth.resend({ type: 'signup', email: em, options: { emailRedirectTo: pageUrl() } }); if (rr.error) throw rr.error; say('Sent! Check your inbox (and spam) for the XRaySavvy email.', true); again.remove(); }
                catch (e2) { say(friendly(e2)); again.disabled = false; }
              };
              if (!document.getElementById('xrs-resend')) form.appendChild(again);
              return;
            }
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
        try { var sb = await loadClient(); var r = await sb.auth.resetPasswordForEmail(em, { redirectTo: pageUrl() }); if (r.error) throw r.error; say('If that email has an account, a reset link is on its way. Check your inbox (and spam), then tap the link.', true); }
        catch (err) { say(friendly(err)); } finally { go2.disabled = false; }
      };
      sheet.appendChild(h('label', { for: 'xrs-email', text: 'Email' })); sheet.appendChild(em2); sheet.appendChild(go2); sheet.appendChild(msg);
      sheet.appendChild(h('button', { class: 'xrs-link', onclick: function () { openSheet('login'); }, text: '← Back to log in' }));
    } else if (view === 'newpass') {
      var np = h('input', { type: 'password', id: 'xrs-pass', autocomplete: 'new-password', minlength: '6' });
      sheet.setAttribute('data-view', 'newpass'); np.id = 'xrs-newpass';
      var go3 = h('button', { class: 'xrs-go', text: 'Save new password' });
      go3.onclick = async function () {
        if (np.value.length < 6) return say('Password needs at least 6 characters.');
        go3.disabled = true;
        try { var sb = await loadClient(); var r = await sb.auth.updateUser({ password: np.value }); if (r.error) throw r.error; say('Password updated. You\'re logged in.', true); setTimeout(closeSheet, 1200); }
        catch (err) { say(friendly(err)); } finally { go3.disabled = false; }
      };
      sheet.appendChild(h('label', { for: 'xrs-newpass', text: 'New password (at least 6 characters)' })); sheet.appendChild(np); sheet.appendChild(go3); sheet.appendChild(msg);
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
      // Owner only (the usage page and its data are also locked server-side).
      if (u.id === OWNER_ID) sheet.appendChild(h('div', { style: 'text-align:center;margin-top:0.4rem' }, [h('a', { href: './admin.html', id: 'xrs-usage', style: 'color:var(--muted,#8b98a5);font-size:0.8rem;text-decoration:none', text: 'Usage' })]));
    }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  // Open the login sheet straight in a mode: openAuth('signup') or openAuth('login').
  function openAuth(mode) { openSheet(mode === 'login' ? 'login' : mode === 'signup' ? 'signup' : undefined); }

  // ---------------- friendly sign-up nudge (signed-out only; never blocks anything) ----------------
  // At most once per browser session, snoozed 3 days after "Not now", never again once this device has
  // seen an account (logged in here, or signed up here).
  var NUDGE_KEY = 'xraysavvy.signupNudge.v1', HAS_ACCT_KEY = 'xraysavvy.hasAccount', NUDGE_SESSION = 'xraysavvy.signupNudge.shown';
  var SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
  function markHasAccount() { lsSet(HAS_ACCT_KEY, '1'); }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } }
  function nudgeAllowed() {
    if (XRS.user || storedUser() || lsGet(HAS_ACCT_KEY)) return false;
    if (ssGet(NUDGE_SESSION)) return false;
    try { var st = JSON.parse(lsGet(NUDGE_KEY) || '{}') || {}; if (st.snoozeUntil && Date.now() < st.snoozeUntil) return false; } catch (e) { }
    if (ov || document.getElementById('xrs-nudge')) return false;
    return true;
  }
  function hideNudge() { var n = document.getElementById('xrs-nudge'); if (n) n.remove(); }
  // nudge({ after: element to place the card right after, text: 'Nice, 8 correct! 🎉' }) -> true if shown
  function nudge(opts) {
    try {
      opts = opts || {};
      if (!nudgeAllowed() || !opts.after || !opts.after.parentNode) return false;
      addCss();
      ssSet(NUDGE_SESSION, '1');
      var card = h('div', { class: 'xrs-nudge', id: 'xrs-nudge', role: 'status', 'aria-live': 'polite' }, [
        h('p', { id: 'xrs-nudge-text', text: (opts.text || 'Nice work! 🎉') + ' Make a free account to save your progress on every device.' }),
        h('div', { class: 'xrs-nudge-row' }, [
          h('button', { type: 'button', class: 'xrs-nudge-go', id: 'xrs-nudge-go', text: 'Create free account', onclick: function () { hideNudge(); openAuth('signup'); } }),
          h('button', { type: 'button', class: 'xrs-nudge-later', id: 'xrs-nudge-later', text: 'Not now', onclick: snooze })]),
        h('button', { type: 'button', class: 'xrs-nudge-x', 'aria-label': 'Dismiss', text: '×', onclick: snooze })]);
      opts.after.parentNode.insertBefore(card, opts.after.nextSibling);
      return true;
    } catch (e) { return false; }
  }
  function snooze() { lsSet(NUDGE_KEY, JSON.stringify({ snoozeUntil: Date.now() + SNOOZE_MS })); hideNudge(); }

  function boot() {
    addCss(); renderButton();
    if (XRS.user) markHasAccount();
    // Load the library right away only when someone is logged in or arriving from an email link;
    // otherwise wait until the page is idle so logged-out visitors pay nothing up front.
    var fromLink = !!(ARRIVAL.tokenHash || ARRIVAL.implicit || ARRIVAL.error) || /type=recovery|type=signup/.test(location.hash + location.search);
    if (XRS.user || fromLink) loadClient().catch(function () { });
    else setTimeout(function () { loadClient().catch(function () { }); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
