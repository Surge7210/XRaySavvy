// XRaySavvy study helper - Cloudflare Worker (module syntax)
// Receives study-note text from upload.html and asks Google Gemini (free tier)
// to write quiz questions, section summaries and explanations from it.
// Actions (POST JSON field "action"):
//   'questions' (default) {text, count, type, focus}      -> {questions[]}
//   'section'   {text, title, count, type}               -> {title, summary, keyPoints[], questions[]}
//   'explain'   {text, style:'simple'|'detail', summary} -> {explanation}
//   'ask'       {text, question, context}                -> {answer, inNotes}
//   'ocr'       {images:[{data, mimeType}]}  (base64, 1-4) -> {text, pages[]}  reads photos/screenshots
// The Gemini key lives ONLY in the Worker
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
const MAX_QUESTION_CHARS = 500;     // 'ask' question length
const MAX_SUMMARY_CHARS = 4000;     // summary sent back with 'explain'
const MAX_SECTION_QUESTIONS = 6;
// Photo reading ('ocr'): the page shrinks each photo to ~1600px JPEG (~150-600 KB) before sending.
const MAX_OCR_BODY_BYTES = 8 * 1024 * 1024;   // whole 'ocr' request body
const MAX_OCR_IMAGES = 4;                     // photos per request (the page sends 1 at a time)
const MAX_IMAGE_B64_CHARS = 4 * 1024 * 1024;  // ~3 MB per photo after base64
const OCR_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const ACTIONS = ['questions', 'section', 'explain', 'ask', 'ocr'];
// Tried when MODEL is overloaded/unavailable (HTTP 5xx or 404) or out of quota (HTTP 429).
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const geminiUrl = m => 'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent';

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
    TERM_LIST_RULE,
    'No duplicate questions. Do not ask about slide numbers, file names, or formatting. Every question must stand on its own: never mention or point to a slide, page, figure, image, or "the notes" (no "on slide 3", "in this image", "as shown"); the student cannot see the source while answering, so name the anatomy or topic directly.',
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

// Same question object as above, reused inside the section schema.
const QUESTION_ITEM = RESPONSE_SCHEMA.properties.questions.items;

const SECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Short section title (2-8 words) taken from the notes headings' },
    summary: { type: 'STRING', description: '80-150 words. Plain sentences. Wrap the most important key terms in **double asterisks**.' },
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' }, description: '3-5 short bullet facts to remember' },
    questions: { type: 'ARRAY', items: QUESTION_ITEM }
  },
  required: ['title', 'summary', 'keyPoints', 'questions'],
  propertyOrdering: ['title', 'summary', 'keyPoints', 'questions']
};

const EXPLAIN_SCHEMA = {
  type: 'OBJECT',
  properties: { explanation: { type: 'STRING' } },
  required: ['explanation']
};

const ASK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    inNotes: { type: 'BOOLEAN', description: 'true only if the notes contain the answer' },
    answer: { type: 'STRING' }
  },
  required: ['inNotes', 'answer'],
  propertyOrdering: ['inNotes', 'answer']
};

// Extra guidance for vocabulary handouts (e.g. "Term -- definition" lines from a photographed handout).
const TERM_LIST_RULE = 'If the notes are (or include) a terminology/vocabulary list of term-definition pairs, quiz the pairs in both directions: "Which term means <definition>?" and "What does <term> mean?" / "Define <term>". For those multiple choice questions, take the wrong choices from OTHER terms (or other definitions) on the same list so they are plausible. Short answer questions on a term list must give the definition and ask for the term (answer = just the term); never make a short answer question whose answer is a whole definition. Spread questions across different terms instead of repeating a term.';

const NOTES_ONLY = 'IMPORTANT: Use ONLY facts stated in the provided notes. Do not add outside knowledge or invent numbers, angles or steps. Keep medical and technical accuracy: never change a fact to make it simpler.';

function notesBlock(text, label) {
  return ['', '=== ' + (label || 'STUDY NOTES') + ' START ===', text, '=== ' + (label || 'STUDY NOTES') + ' END ==='].join('\n');
}

function buildSectionPrompt(text, title, count, type) {
  const typeRule = type === 'mc'
    ? 'Every question is multiple choice (type "mc") with exactly 4 choices.'
    : type === 'short'
      ? 'Every question is short answer (type "short"): choices = [], answerIndex = -1, answer of 1-6 words.'
      : 'Mix multiple choice (type "mc", exactly 4 choices) and short answer (type "short", choices = [], answerIndex = -1, answer of 1-6 words).';
  return [
    'You are a friendly tutor helping a radiologic technology student learn one section of their class notes.',
    title ? 'The section is probably about: "' + title + '".' : '',
    NOTES_ONLY,
    'Return:',
    '- title: a short, clear title for this section (2-8 words) based on its headings.',
    '- summary: a smart summary of 80-150 words that teaches the main ideas in order, in plain sentences. Wrap the most important key terms in **double asterisks** (about 3-8 terms).',
    '- keyPoints: 3-5 short bullet facts worth memorizing (no asterisks).',
    '- questions: exactly ' + count + ' quiz questions covering the most testable facts in THIS section only. ' + typeRule,
    'For multiple choice: wrong choices must be plausible but clearly wrong according to the notes; vary the position of the correct answer; answer must equal choices[answerIndex].',
    'Each explanation: 1-2 sentences using the notes. sourceHint: the slide or page label (e.g. "Slide 12", "Page 3") from the markers in the notes if present.',
    TERM_LIST_RULE,
    'Do not ask about slide numbers, file names, or formatting. Every question must stand on its own: never mention or point to a slide, page, figure, image, or "the notes" (no "on slide 3", "in this image", "as shown"); the student cannot see the source while answering, so name the anatomy or topic directly.',
    notesBlock(text, 'SECTION NOTES')
  ].filter(Boolean).join('\n');
}

function buildExplainPrompt(text, style, summary) {
  const how = style === 'simple'
    ? [
      'The student said "um dumb it down pls.." - they are confused. Re-explain this section so a beginner gets it.',
      'Use very simple, everyday words and short sentences. Define any unavoidable technical term in plain words right after it.',
      'Include exactly ONE everyday analogy (e.g. comparing something to a flashlight, a garden hose, a camera). Label it with "Think of it like:".',
      'Keep it to about 80-160 words. You may use **double asterisks** for 2-4 key terms. Still keep every fact correct.'
    ]
    : [
      'The student wants MORE DETAIL on this section. Go deeper than the summary: explain the why/how, list specifics (numbers, angles, positions, relationships) and how the ideas connect.',
      'Only use details that are actually in the notes. If the notes do not go deeper on something, do not make it up.',
      'Use short paragraphs or "- " bullet lines, about 150-300 words. Use **double asterisks** for key terms.'
    ];
  return [
    'You are a friendly tutor helping a radiologic technology student with one section of their class notes.',
    NOTES_ONLY,
    ...how,
    summary ? '\nThe student already read this summary:\n' + summary : '',
    notesBlock(text, 'SECTION NOTES')
  ].filter(Boolean).join('\n');
}

function buildAskPrompt(text, question, context) {
  return [
    'You are a friendly tutor answering a radiologic technology student\'s question about their class notes.',
    NOTES_ONLY,
    'Answer the question using the SECTION NOTES first; you may also use the OTHER NOTES FROM THE SAME FILE if given.',
    'If the notes do not contain the answer, set inNotes to false and say plainly that it isn\'t covered in their notes (you may say what the notes DO cover that is related). Do not answer from outside knowledge.',
    'If the notes do contain it, set inNotes to true and answer in 1-5 short sentences in simple words. You may use **double asterisks** for key terms and mention the slide/page if helpful.',
    '',
    'STUDENT QUESTION: ' + question,
    notesBlock(text, 'SECTION NOTES'),
    context ? notesBlock(context, 'OTHER NOTES FROM THE SAME FILE') : ''
  ].filter(Boolean).join('\n');
}

const OCR_PROMPT = [
  'You are transcribing a photo or screenshot of a radiologic technology student\'s study material (handout, slide, notes or textbook page).',
  'Transcribe ALL of the readable text faithfully, in normal reading order (top to bottom; for multiple columns, finish the left column before the right).',
  'Copy the words exactly as written: keep medical spelling, numbers, units, abbreviations and symbols. Do not summarize, explain, correct, translate or add anything.',
  'Keep the structure with plain-text lines: titles/headings on their own line, list items on their own line starting with "- ", and paragraphs as paragraphs.',
  'For a terminology/vocabulary list or a table of term + definition, write each pair on ONE line as "Term -- definition" (even if the original uses a colon, dash, columns or bold), in the original order.',
  'For other tables, write one row per line with cells separated by " | ".',
  'If a word is truly unreadable write [illegible]. Ignore phone status bars, app buttons and other screen chrome that is not part of the material.',
  'If the image has no readable study text at all, reply with exactly: NO_TEXT',
  'Reply with only the transcription (no preamble, no markdown code fences).'
].join('\n');

// Validates body.images (or a single body.image) -> {images} or {error}.
function readImages(body) {
  let list = Array.isArray(body.images) ? body.images : body.image ? [{ data: body.image, mimeType: body.mimeType }] : [];
  if (!list.length) return { error: ['no_image', 'No photo was sent.'] };
  if (list.length > MAX_OCR_IMAGES) return { error: ['too_many', 'Send at most ' + MAX_OCR_IMAGES + ' photos per request.'] };
  const out = [];
  for (const it of list) {
    let data = typeof it === 'string' ? it : it && typeof it.data === 'string' ? it.data : '';
    let mime = (it && typeof it.mimeType === 'string' ? it.mimeType : '').toLowerCase();
    const m = /^data:([^;,]+);base64,/.exec(data);
    if (m) { if (!mime) mime = m[1].toLowerCase(); data = data.slice(m[0].length); }
    data = data.replace(/\s+/g, '');
    if (!mime) mime = 'image/jpeg';
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!OCR_MIME.includes(mime)) return { error: ['bad_image', 'That photo type (' + cleanStr(mime, 40) + ') is not supported. Use a JPEG, PNG or screenshot.'] };
    if (data.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: ['bad_image', 'The photo data was empty or damaged. Try picking it again.'] };
    if (data.length > MAX_IMAGE_B64_CHARS) return { error: ['too_large', 'That photo is too big (over ~3 MB after shrinking). Try a screenshot or a smaller photo.'] };
    out.push({ inline_data: { mime_type: mime, data } });
  }
  return { images: out };
}

// Multi-line text cleanup (keeps paragraph breaks and "- " bullets).
function cleanText(v, max) {
  return (typeof v === 'string' ? v : v == null ? '' : String(v))
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

// Calls Gemini and returns either {parsed} or {error: Response}.
async function callGemini(env, cors, prompt, schema, opts) {
  opts = opts || {};
  const models = [MODEL, FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let gRes;
  for (let mi = 0; mi < models.length; mi++) {
  const last = mi === models.length - 1;
  try {
    gRes = await fetch(geminiUrl(models[mi]), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: (opts.parts || []).concat([{ text: prompt }]) }],
        generationConfig: Object.assign(schema ? { responseMimeType: 'application/json', responseSchema: schema } : { responseMimeType: 'text/plain' }, {
          temperature: opts.temperature == null ? 0.4 : opts.temperature,
          maxOutputTokens: opts.maxOutputTokens || 16384
        })
      })
    });
  } catch (e) {
    if (!last) continue;
    return { error: json({ error: 'network', message: 'Could not reach Google Gemini. Try again in a moment.' }, 502, cors) };
  }
  if (!last && (gRes.status >= 500 || gRes.status === 404 || gRes.status === 429)) continue; // overloaded, retired, or over its daily/minute limit: try the fallback model (it has its own separate quota)
  break;
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
    return {
      error: json({
        error: 'rate_limit',
        perDay,
        retryAfterSeconds,
        message: perDay
          ? "Gemini's free daily limit is used up. It resets at midnight Pacific time. Your progress so far is kept."
          : "Gemini's free tier is busy (too many requests per minute). Wait about a minute and try again."
      }, 429, cors)
    };
  }

  if (!gRes.ok) {
    let detail = '';
    try { const e = await gRes.json(); detail = (e.error && e.error.message) || ''; } catch (e) { /* ignore */ }
    const keyProblem = gRes.status === 400 && /api key/i.test(detail) || gRes.status === 401 || gRes.status === 403;
    return {
      error: json({
        error: keyProblem ? 'bad_key' : 'gemini_error',
        status: gRes.status,
        message: keyProblem
          ? 'Google rejected the API key. Check the GEMINI_API_KEY secret in the Worker settings.'
          : gRes.status === 503 || /high demand|overloaded/i.test(detail)
            ? "Google's Gemini AI is overloaded right now (on Google's side). Wait a minute and try again."
            : 'Gemini returned an error (' + gRes.status + '). ' + detail.slice(0, 200)
      }, 502, cors)
    };
  }

  let data;
  try { data = await gRes.json(); } catch (e) {
    return { error: json({ error: 'bad_response', message: 'Gemini sent back something unreadable. Try again.' }, 502, cors) };
  }
  const cand = data.candidates && data.candidates[0];
  const out = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('') : '';
  if (!schema) {
    const reason = cand && cand.finishReason;
    if (!out.trim() && (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || (data.promptFeedback && data.promptFeedback.blockReason))) {
      return { error: json({ error: 'blocked', message: 'Gemini refused to read this image (safety filter). Try a different photo.' }, 422, cors) };
    }
    return { raw: out, finishReason: reason };
  }
  try { return { parsed: JSON.parse(out) }; } catch (e) {
    const reason = cand && cand.finishReason;
    return {
      error: json({
        error: 'bad_response',
        message: reason === 'MAX_TOKENS' ? 'Gemini ran out of room. Try a smaller request.'
          : reason === 'SAFETY' ? 'Gemini blocked this text for safety reasons.'
          : 'Gemini did not return a usable answer. Try again.'
      }, 502, cors)
    };
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
    }
    if (request.method === 'GET') {
      return json({ ok: true, service: 'XRaySavvy quiz worker', model: MODEL, keySet: !!env.GEMINI_API_KEY, actions: ACTIONS }, 200, cors);
    }
    if (request.method !== 'POST') return json({ error: 'method', message: 'Use POST.' }, 405, cors);
    if (origin && !cors.ok) return json({ error: 'origin', message: 'This site is not allowed to use this Worker.' }, 403, cors);

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'no_key', message: 'The Worker is missing its GEMINI_API_KEY secret. Add it under Settings > Variables and Secrets, then Deploy.' }, 500, cors);
    }

    // Photos ('ocr') may be up to MAX_OCR_BODY_BYTES; every other action keeps the small text limit (checked below).
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_OCR_BODY_BYTES) return json({ error: 'too_large', message: 'That upload is too big. Send fewer or smaller photos at a time.' }, 413, cors);

    let body, rawLen = 0;
    try {
      const raw = await request.text();
      rawLen = raw.length;
      if (rawLen > MAX_OCR_BODY_BYTES) return json({ error: 'too_large', message: 'That upload is too big. Send fewer or smaller photos at a time.' }, 413, cors);
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: 'bad_json', message: 'Request was not valid JSON.' }, 400, cors);
    }
    if (!body || typeof body !== 'object') return json({ error: 'bad_json', message: 'Request was not valid JSON.' }, 400, cors);

    const action = body.action == null || body.action === '' ? 'questions' : body.action;
    if (!ACTIONS.includes(action)) {
      return json({ error: 'bad_action', message: 'Unknown action "' + cleanStr(action, 40) + '".' }, 400, cors);
    }

    // ---- Photo / screenshot reading: returns the text, which the page then treats like a slide ----
    if (action === 'ocr') {
      const im = readImages(body);
      if (im.error) return json({ error: im.error[0], message: im.error[1] }, im.error[0] === 'too_large' ? 413 : 400, cors);
      const r = await callGemini(env, cors, OCR_PROMPT, null, { parts: im.images, temperature: 0, maxOutputTokens: 8192 });
      if (r.error) return r.error;
      let out = cleanText(r.raw.replace(/^```[a-z]*\n?|\n?```\s*$/gi, ''), MAX_TEXT_CHARS);
      if (!out || /^NO_TEXT\.?$/i.test(out) || out.replace(/\[illegible\]|NO_TEXT/gi, '').replace(/[^a-z0-9]/gi, '').length < 10) {
        return json({ error: 'no_text', message: 'No readable text was found in that photo. Make sure the words are in focus and not too small.' }, 422, cors);
      }
      return json({ text: out, truncated: r.finishReason === 'MAX_TOKENS', model: MODEL }, 200, cors);
    }
    if (rawLen > MAX_BODY_BYTES) return json({ error: 'too_large', message: 'That chunk is too big. Try a smaller file.' }, 413, cors);

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < MIN_TEXT_CHARS) return json({ error: 'too_short', message: 'Not enough text to work with.' }, 400, cors);
    if (text.length > MAX_TEXT_CHARS) return json({ error: 'too_large', message: 'Text chunk is over ' + MAX_TEXT_CHARS + ' characters.' }, 413, cors);
    const type = ['mc', 'short', 'mix'].includes(body.type) ? body.type : 'mix';

    // ---- Quiz questions (Exam Cram) ----
    if (action === 'questions') {
      const count = Math.max(1, Math.min(MAX_COUNT, parseInt(body.count, 10) || 10));
      const focus = cleanStr(body.focus, MAX_FOCUS_CHARS);
      const r = await callGemini(env, cors, buildPrompt(text, count, type, focus), RESPONSE_SCHEMA);
      if (r.error) return r.error;
      const questions = sanitize(Array.isArray(r.parsed) ? r.parsed : r.parsed.questions, type);
      if (!questions.length) return json({ error: 'empty', message: 'Gemini could not make questions from this text.' }, 502, cors);
      return json({ questions, model: MODEL }, 200, cors);
    }

    // ---- Learn mode: one section's summary + questions ----
    if (action === 'section') {
      const count = Math.max(1, Math.min(MAX_SECTION_QUESTIONS, parseInt(body.count, 10) || 3));
      const title = cleanStr(body.title, 120);
      const r = await callGemini(env, cors, buildSectionPrompt(text, title, count, type), SECTION_SCHEMA);
      if (r.error) return r.error;
      const p = r.parsed || {};
      const summary = cleanText(p.summary, 2500);
      if (!summary) return json({ error: 'empty', message: 'Gemini could not summarize this section. Try again.' }, 502, cors);
      return json({
        title: cleanStr(p.title, 120) || title || 'Section',
        summary,
        keyPoints: (Array.isArray(p.keyPoints) ? p.keyPoints : []).map(k => cleanStr(k, 300).replace(/\*\*/g, '')).filter(Boolean).slice(0, 6),
        questions: sanitize(p.questions, type).slice(0, count),
        model: MODEL
      }, 200, cors);
    }

    // ---- Learn mode: "um dumb it down pls.." / "More detail" ----
    if (action === 'explain') {
      const style = body.style === 'detail' ? 'detail' : 'simple';
      const summary = cleanText(body.summary, MAX_SUMMARY_CHARS);
      const r = await callGemini(env, cors, buildExplainPrompt(text, style, summary), EXPLAIN_SCHEMA, { temperature: style === 'simple' ? 0.6 : 0.4, maxOutputTokens: 8192 });
      if (r.error) return r.error;
      const explanation = cleanText(r.parsed && r.parsed.explanation, 5000);
      if (!explanation) return json({ error: 'empty', message: 'Gemini did not send an explanation. Try again.' }, 502, cors);
      return json({ style, explanation, model: MODEL }, 200, cors);
    }

    // ---- Learn mode: "Ask a question" (answered only from the notes) ----
    const question = cleanStr(body.question, MAX_QUESTION_CHARS);
    if (question.length < 2) return json({ error: 'no_question', message: 'Type a question first.' }, 400, cors);
    let context = typeof body.context === 'string' ? body.context.trim() : '';
    if (text.length + context.length > MAX_TEXT_CHARS) context = context.slice(0, Math.max(0, MAX_TEXT_CHARS - text.length));
    const r = await callGemini(env, cors, buildAskPrompt(text, question, context), ASK_SCHEMA, { temperature: 0.3, maxOutputTokens: 4096 });
    if (r.error) return r.error;
    const answer = cleanText(r.parsed && r.parsed.answer, 3000);
    if (!answer) return json({ error: 'empty', message: 'Gemini did not send an answer. Try again.' }, 502, cors);
    return json({ question, answer, inNotes: !!(r.parsed && r.parsed.inNotes === true), model: MODEL }, 200, cors);
  }
};
