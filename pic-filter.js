// Slide-picture filter for upload.html: decides which pictures pulled from a PPTX/PDF are worth
// showing under a Learn section (anatomy, radiographs, positioning photos) and which are junk
// (title/header banners, text-only images, flat fills, duplicates, template art).
// Pure functions over RGBA pixel arrays, so the same code runs in the browser and in Node tests.
(function (root) {
  'use strict';
  var SIZE = 96;              // analyse on a canvas whose longer side is this many pixels
  var MAX_ASPECT = 3;         // wider than 3:1 or taller than 1:3 => banner / strip
  var MIN_LONG = 220, MIN_SHORT = 120;   // original-size minimum (smaller => icon / thumbnail)

  function lum(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }

  // Look at a downscaled copy of the picture. origW/origH are the picture's real size.
  function analyze(px, w, h, origW, origH) {
    origW = origW || w; origH = origH || h;
    var ar = Math.max(origW, origH) / Math.max(1, Math.min(origW, origH));
    if (ar > MAX_ASPECT) return { keep: false, reason: 'banner shape' };
    if (Math.max(origW, origH) < MIN_LONG || Math.min(origW, origH) < MIN_SHORT) return { keep: false, reason: 'too small' };
    var n = w * h, bins = {}, gray = new Array(32).fill(0), sum = 0, sum2 = 0, mid = 0, light = 0, edges = 0, edgeN = 0;
    var L = new Float32Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var r = px[p], g = px[p + 1], b = px[p + 2];
      var y = lum(r, g, b); L[i] = y;
      sum += y; sum2 += y * y; gray[Math.min(31, y >> 3)]++;
      if (y > 40 && y < 215) mid++;
      if (y >= 225) light++;
      // 3 bits per channel colour bins; near-white and near-black each collapse into one bin
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), key;
      if (mn >= 225) key = 'W'; else if (mx <= 30) key = 'K';
      else key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
      bins[key] = (bins[key] || 0) + 1;
    }
    var counts = Object.keys(bins).map(function (k) { return bins[k]; }).sort(function (a, b) { return b - a; });
    var top1 = counts[0] / n, top2 = (counts[0] + (counts[1] || 0)) / n;
    var colors = 0; for (var c = 0; c < counts.length; c++) if (counts[c] / n >= 0.004) colors++;
    var levels = 0; for (var q = 0; q < 32; q++) if (gray[q] / n >= 0.004) levels++;
    var mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    var midFrac = mid / n, lightFrac = light / n;
    // Sharp edges: rendered text and line art are hard black/white steps, photos and X-rays are smoother.
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx + 1 < w; xx++) {
      var d = Math.abs(L[yy * w + xx] - L[yy * w + xx + 1]); edgeN++;
      if (d > 60) edges++;
    }
    var sharpFrac = edges / Math.max(1, edgeN);
    var m = { top1: +top1.toFixed(3), top2: +top2.toFixed(3), colors: colors, levels: levels, std: +std.toFixed(1), mid: +midFrac.toFixed(3), light: +lightFrac.toFixed(3), sharp: +sharpFrac.toFixed(3) };
    var why = null;
    if (top1 > 0.72) why = 'mostly one colour';
    else if (lightFrac > 0.65 && (colors < 12 || lightFrac > 0.78)) why = 'mostly white (text/slide page)';
    else if (std < 14) why = 'almost no contrast';
    else if (colors < 6 && levels < 10) why = 'too few colours or grey levels (text/graphic)';
    else if (top2 > 0.85 && midFrac < 0.3) why = 'two-tone (text on a plain background)';
    else if (midFrac < 0.15) why = 'no mid-tones (text/line graphic)';
    else if (lightFrac > 0.6 && levels < 16) why = 'text on white';
    else if (lightFrac > 0.45 && midFrac < 0.4 && sharpFrac > 0.04) why = 'text on white';
    return why ? { keep: false, reason: why, m: m } : { keep: true, m: m };
  }

  // 64-bit difference hash (9x8 grayscale) as a 16-char hex string.
  function dhash(px9x8) {
    var g = [], bits = '', hex = '';
    for (var i = 0; i < 72; i++) g.push(lum(px9x8[i * 4], px9x8[i * 4 + 1], px9x8[i * 4 + 2]));
    for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? '1' : '0';
    for (var k = 0; k < 64; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
    return hex;
  }
  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    var d = 0;
    for (var i = 0; i < a.length; i++) { var x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
    return d;
  }
  var DUP = 6;   // hashes this close (out of 64 bits) count as the same picture

  // items: [{ n (slide/page), hash, ... }] in deck order. Groups near-identical pictures across the
  // whole deck; drops a group that shows up on many slides (logo/template art) and keeps only the
  // first copy of any other group. Returns the kept items.
  function select(items, total) {
    var groups = [];
    items.forEach(function (it) {
      var g = null;
      for (var i = 0; i < groups.length && !g; i++) if (hamming(groups[i].hash, it.hash) <= DUP) g = groups[i];
      if (!g) { g = { hash: it.hash, units: {}, first: it }; groups.push(g); }
      g.units[it.n] = 1;
      it._g = g;
    });
    var out = [];
    items.forEach(function (it) {
      var g = it._g; delete it._g;
      var count = Object.keys(g.units).length;
      if (repeated(count, total)) return;
      if (g.first !== it) return;
      out.push(it);
    });
    return out;
  }
  function repeated(count, total) { return count >= 5 || (count >= 3 && count >= (total || 0) * 0.25); }

  // Browser helpers: draw any drawable (canvas/ImageBitmap/img) small and run the checks.
  function scaled(src, sw, sh) {
    var s = Math.min(1, SIZE / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
    var data = x.getImageData(0, 0, w, h).data;
    var c2 = document.createElement('canvas'); c2.width = 9; c2.height = 8;
    var x2 = c2.getContext('2d', { willReadFrequently: true });
    x2.drawImage(c, 0, 0, 9, 8);
    var small = x2.getImageData(0, 0, 9, 8).data;
    c.width = 0; c.height = 0;
    return { data: data, w: w, h: h, hash: dhash(small) };
  }
  function check(src, sw, sh, origW, origH) {
    var s = scaled(src, sw, sh);
    var r = analyze(s.data, s.w, s.h, origW || sw, origH || sh);
    r.hash = s.hash;
    return r;
  }

  var api = { VERSION: 2, analyze: analyze, dhash: dhash, hamming: hamming, select: select, repeated: repeated, check: check, SIZE: SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PicFilter = api;
})(typeof window !== 'undefined' ? window : this);
