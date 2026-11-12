/* First-party page views for XRaySavvy. Fails silently and never blocks the UI.
   Stores a random anonymous visitor id in localStorage. No cookies, no IPs,
   no emails, no raw user-agent strings. signed_in / is_owner are set by the server. */
(function () {
  'use strict';
  var VID_KEY = 'xraysavvy.vid';
  var TABS_KEY = 'xraysavvy.pv.tabs';
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var OWN_HOSTS = { 'xraysavvy.com': 1, 'www.xraysavvy.com': 1, 'surge7210.github.io': 1 };

  function uuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e2) {
      for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function visitorId() {
    function valid(id) { return id && UUID_RE.test(id) ? id : null; }
    try {
      var id = valid(localStorage.getItem(VID_KEY));
      if (id) return id;
      id = uuid();
      localStorage.setItem(VID_KEY, id);
      return id;
    } catch (e) {}
    try {
      var sid = valid(sessionStorage.getItem(VID_KEY));
      if (sid) return sid;
      sid = uuid();
      sessionStorage.setItem(VID_KEY, sid);
      return sid;
    } catch (e2) { return uuid(); }
  }

  function path() {
    var p = location.pathname || '/';
    if (/\/index\.html$/i.test(p)) p = p.replace(/\/index\.html$/i, '/') || '/';
    if (p === '') p = '/';
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.length > 200) p = p.slice(0, 200);
    return p;
  }

  function tabName() {
    var p = (location.pathname || '').toLowerCase();
    if (/\/admin\.html$/.test(p)) return 'admin';
    if (/\/upload\.html$/.test(p)) return 'upload';
    if (!document.getElementById('tab-ref')) return null;
    var h = (location.hash || '').replace(/^#/, '').toLowerCase();
    if (h === 'quiz' || h === 'random' || h === 'focus' || h === 'focused' || h === 'mc' || h === 'multiple-choice') return 'quiz';
    if (h === 'flashcards' || h === 'flash') return 'flashcards';
    if (h === 'progress') return 'progress';
    var active = document.querySelector('.bottom-tabs .bt.active');
    if (active) {
      if (active.id === 'tab-quiz') return 'quiz';
      if (active.id === 'tab-flash') return 'flashcards';
      if (active.id === 'tab-progress') return 'progress';
    }
    return 'reference';
  }

  function device() {
    var w = (window.visualViewport && visualViewport.width) || window.innerWidth || 390;
    if (w < 700) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  function referrerDomain() {
    try {
      if (!document.referrer) return null;
      var u = new URL(document.referrer);
      var host = (u.hostname || '').replace(/^www\./i, '').toLowerCase();
      if (!host) return null;
      var here = (location.hostname || '').replace(/^www\./i, '').toLowerCase();
      if (host === here || OWN_HOSTS[host] || OWN_HOSTS[u.hostname.toLowerCase()]) return null;
      if (!/^[A-Za-z0-9.-]+$/.test(host) || host.length > 253) return null;
      return host;
    } catch (e) { return null; }
  }

  function readTabs() {
    try {
      var arr = JSON.parse(sessionStorage.getItem(TABS_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function markTab(tab) {
    if (!tab) return;
    try {
      var arr = readTabs();
      if (arr.indexOf(tab) === -1) {
        arr.push(tab);
        sessionStorage.setItem(TABS_KEY, JSON.stringify(arr));
      }
    } catch (e) {}
  }

  function send(kind) {
    try {
      if (!window.XRS || !XRS.client) return;
      var tab = tabName();
      if (kind === 'tab' && (!tab || readTabs().indexOf(tab) !== -1)) return;
      if (kind === 'tab') markTab(tab);
      XRS.client().then(function (sb) {
        return sb.from('page_views').insert({
          visitor_id: visitorId(),
          path: path(),
          tab: tab,
          referrer_domain: referrerDomain(),
          device: device()
        });
      }).then(function () {
        if (kind === 'page') markTab(tab);
      }).catch(function () {});
    } catch (e) {}
  }

  function boot() {
    send('page');
    function maybeTab() { setTimeout(function () { send('tab'); }, 0); }
    window.addEventListener('hashchange', maybeTab);
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('#tab-ref, #tab-quiz, #tab-flash, #tab-progress, #tab-random, #tab-focus, #tab-mc');
      if (t) maybeTab();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
