// XRaySavvy quiz generator - Cloudflare Worker (module syntax)
// Receives study-note text from upload.html and asks Google Gemini (free tier)
// to write quiz questions from it. The Gemini key lives ONLY in the Worker
// secret GEMINI_API_KEY (Settings > Variables and Secrets). Never paste it here.

// ---- Settings you might change ----
// Free-tier Flash-Lite model (see https://ai.google.dev/gemini-api/docs/models).
// If Google retires it, swap in another free-tier model id, e.g. 'gemini-3.1-flash-lite'.
const MODEL = 'gemini-3.5-flash-lite';
const ALLOWED_ORIGINS = ['https://surge7210.github.io'];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY_BYTES = 300 * 1024;  // whole request body
const MAX_TEXT_CHARS = 60000;       // text per request (the page sends ~25-40k chunks)
const MIN_TEXT_CHARS = 40;
const MAX_COUNT = 50;               // questions per request (the page splits bigger jobs)
const MAX_FOCUS_CHARS = 300;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['mc', 'short'], description: "'mc' = multiple choice, 'short' = short answer" },
          question: { type: 'STRING' },
          choices: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Exactly 4 options for mc; empty array for short' },
          answerIndex: { type: 'INTEGER', description: 'Index (0-3) of the correct choice for mc; -1 for short' },
          answer: { type: 'STRING', description: 'The correct answer in a few words' },
          explanation: { type: 'STRING', description: '1-2 sentences, based only on the provided text' },
          sourceHint: { type: 'STRING', description: 'Where in the notes this came from, e.g. "Slide 12" or "Page 3"' }
        },
        required: ['type', 'question', 'choices', 'answerIndex', 'answer', 'explanation', 'sourceHint'],
        propertyOrdering: ['type', 'question', 'choices', 'answerIndex', 'answer', 'explanation', 'sourceHint']
      }
    }
  },
  required: ['questions']
};

function corsHeaders(origin) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin));
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return { ok, headers: h };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors.headers)
  });
}

function buildPrompt(text, count, type, focus) {
  const typeRule = type === 'mc'
    ? 'Every question must be multiple choice (type "mc") with exactly 4 choices.'
    : type === 'short'
      ? 'Every question must be short answer (type "short"): choices = [] and answerIndex = -1. The answer should be a short phrase (1-6 words) a student could type.'
      : 'Mix the types: about half multiple choice (type "mc", exactly 4 choices) and half short answer (type "short", choices = [], answerIndex = -1, answer of 1-6 words).';
  const focusRule = focus
    ? 'The student wants extra focus on: "' + focus + '". Prefer questions about that if the notes cover it; otherwise use the most important facts.'
    : 'Cover the most important, testable facts spread across the whole text.';
  return [
    'You are writing study quiz questions for a radiologic technology student.',
    'Write exactly ' + count + ' questions from the study notes below.',
    'IMPORTANT: Use ONLY facts stated in the provided text. Do not add outside knowledge. If the text does not support a question, do not ask it.',
    typeRule,
    focusRule,
    'For multiple choice: wrong choices must be plausible but clearly wrong according to the text; vary the position of the correct answer; answer must equal choices[answerIndex].',
    'Each explanation: 1-2 sentences using the text. sourceHint: the slide or page label (e.g. "Slide 12", "Page 3") from the markers in the text if present, otherwise a short topic name.',
    'No duplicate questions. Do not ask about slide numbers, file names, or formatting.',
    '',
    '=== STUDY NOTES START ===',
    text,
    '=== STUDY NOTES END ==='
  ].join('\n');
}

function cleanStr(v, max) {
  return (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitize(list, wantType) {
  const out = [];
  const seen = new Set();
  for (const q of Array.isArray(list) ? list : []) {
    if (!q || typeof q !== 'object') continue;
    const question = cleanStr(q.question, 600);
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    let choices = Array.isArray(q.choices) ? q.choices.map(c => cleanStr(c, 300)).filter(Boolean).slice(0, 6) : [];
    let type = q.type === 'mc' || q.type === 'short' ? q.type : (choices.length >= 2 ? 'mc' : 'short');
    if (wantType === 'mc') type = 'mc';
    let answer = cleanStr(q.answer, 300);
    let answerIndex = Number.isInteger(q.answerIndex) ? q.answerIndex : -1;
    if (type === 'mc') {
      if (choices.length < 2) {
        if (wantType === 'mc') continue;
        type = 'short'; choices = []; answerIndex = -1;
      } else {
        if (answerIndex < 0 || answerIndex >= choices.length) {
          answerIndex = choices.findIndex(c => c.toLowerCase() === answer.toLowerCase());
          if (answerIndex < 0) continue;
        }
        answer = choices[answerIndex];
      }
    } else {
      choices = []; answerIndex = -1;
    }
    if (!answer) continue;
    seen.add(key);
    out.push({
      type, question, choices, answerIndex, answer,
      explanation: cleanStr(q.explanation, 800),
      sourceHint: cleanStr(q.sourceHint, 80)
    });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
    }
    if (request.method === 'GET') {
      return json({ ok: true, service: 'XRaySavvy quiz worker', model: MODEL, keySet: !!env.GEMINI_API_KEY }, 200, cors);
    }
    if (request.method !== 'POST') return json({ error: 'method', message: 'Use POST.' }, 405, cors);
    if (origin && !cors.ok) return json({ error: 'origin', message: 'This site is not allowed to use this Worker.' }, 403, cors);

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'no_key', message: 'The Worker is missing its GEMINI_API_KEY secret. Add it under Settings > Variables and Secrets, then Deploy.' }, 500, cors);
    }

    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return json({ error: 'too_large', message: 'That chunk is too big. Try a smaller file.' }, 413, cors);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'too_large', message: 'That chunk is too big. Try a smaller file.' }, 413, cors);
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: 'bad_json', message: 'Request was not valid JSON.' }, 400, cors);
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < MIN_TEXT_CHARS) return json({ error: 'too_short', message: 'Not enough text to make questions from.' }, 400, cors);
    if (text.length > MAX_TEXT_CHARS) return json({ error: 'too_large', message: 'Text chunk is over ' + MAX_TEXT_CHARS + ' characters.' }, 413, cors);
    const count = Math.max(1, Math.min(MAX_COUNT, parseInt(body.count, 10) || 10));
    const type = ['mc', 'short', 'mix'].includes(body.type) ? body.type : 'mix';
    const focus = cleanStr(body.focus, MAX_FOCUS_CHARS);

    let gRes;
    try {
      gRes = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildPrompt(text, count, type, focus) }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.4,
            maxOutputTokens: 16384
          }
        })
      });
    } catch (e) {
      return json({ error: 'network', message: 'Could not reach Google Gemini. Try again in a moment.' }, 502, cors);
    }

    if (gRes.status === 429) {
      let retryAfterSeconds = null, perDay = false;
      try {
        const err = await gRes.json();
        const details = (err.error && err.error.details) || [];
        for (const d of details) {
          if (d['@type'] && d['@type'].includes('RetryInfo') && d.retryDelay) retryAfterSeconds = Math.ceil(parseFloat(d.retryDelay));
          if (d['@type'] && d['@type'].includes('QuotaFailure')) {
            for (const v of d.violations || []) if (/PerDay/i.test(v.quotaId || '')) perDay = true;
          }
        }
      } catch (e) { /* ignore */ }
      return json({
        error: 'rate_limit',
        perDay,
        retryAfterSeconds,
        message: perDay
          ? "Gemini's free daily limit is used up. It resets at midnight Pacific time (2 AM Central). Your questions so far are kept."
          : "Gemini's free tier is busy (too many requests per minute). Wait about a minute and try again."
      }, 429, cors);
    }

    if (!gRes.ok) {
      let detail = '';
      try { const e = await gRes.json(); detail = (e.error && e.error.message) || ''; } catch (e) { /* ignore */ }
      const keyProblem = gRes.status === 400 && /api key/i.test(detail) || gRes.status === 401 || gRes.status === 403;
      return json({
        error: keyProblem ? 'bad_key' : 'gemini_error',
        status: gRes.status,
        message: keyProblem
          ? 'Google rejected the API key. Check the GEMINI_API_KEY secret in the Worker settings.'
          : 'Gemini returned an error (' + gRes.status + '). ' + detail.slice(0, 200)
      }, 502, cors);
    }

    let data;
    try { data = await gRes.json(); } catch (e) {
      return json({ error: 'bad_response', message: 'Gemini sent back something unreadable. Try again.' }, 502, cors);
    }
    const cand = data.candidates && data.candidates[0];
    const out = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('') : '';
    let parsed;
    try { parsed = JSON.parse(out); } catch (e) {
      const reason = cand && cand.finishReason;
      return json({
        error: 'bad_response',
        message: reason === 'MAX_TOKENS' ? 'Gemini ran out of room. Try fewer questions.'
          : reason === 'SAFETY' ? 'Gemini blocked this chunk for safety reasons.'
          : 'Gemini did not return quiz questions. Try again.'
      }, 502, cors);
    }
    const questions = sanitize(Array.isArray(parsed) ? parsed : parsed.questions, type);
    if (!questions.length) return json({ error: 'empty', message: 'Gemini could not make questions from this text.' }, 502, cors);
    return json({ questions, model: MODEL }, 200, cors);
  }
};
