import { DurableObject } from 'cloudflare:workers';
// XRaySavvy study helper - Cloudflare Worker (module syntax)
// Receives study-note text from upload.html and asks Google Gemini (free tier)
// to write quiz questions, section summaries and explanations from it.
// Actions (POST JSON field "action"):
//   'questions' (default) {text, count, type, focus}      -> {questions[]}
//   'section'   {text, title, count, type}               -> {title, summary, keyPoints[], questions[]}
//   'explain'   {text, style:'simple'|'detail', summary} -> {explanation}
//   'ask'       {text, question, context}                -> {fromNotes, beyondNotes, masterList, unsure, blocked, answer, inNotes}
//               (notes first; general rad tech knowledge and the class master list in separate, labeled fields)
//   'ocr'       {images:[{data, mimeType}]}  (base64, 1-4) -> {text, pages[]}  reads photos/screenshots
//   'projections' {text}                                 -> {projections[]}  positioning projections found in the notes
//                 (every field is copied from the notes; anything not stated is exactly "not on slides")
// GET ?action=usage (Authorization: Bearer <Supabase access token>) -> owner-only usage counts.
//   Every request is counted in the UsageCounter Durable Object (SQLite, hourly UTC buckets, one row write per request).
// The Gemini key lives ONLY in the Worker
// secret GEMINI_API_KEY (Settings > Variables and Secrets). Never paste it here.

// ---- Settings you might change ----
// Free-tier Flash-Lite model (see https://ai.google.dev/gemini-api/docs/models).
// If Google retires it, swap in another free-tier model id, e.g. 'gemini-3.1-flash-lite'.
const MODEL = 'gemini-3.5-flash-lite';
const ALLOWED_ORIGINS = ['https://surge7210.github.io', 'https://xraysavvy.com', 'https://www.xraysavvy.com'];
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
const ACTIONS = ['questions', 'section', 'explain', 'ask', 'ocr', 'projections'];
// Tried when MODEL is overloaded/unavailable (HTTP 5xx or 404) or out of quota (HTTP 429).
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
// Usage dashboard (admin.html). These are public values: the publishable key is already in auth.js.
const SUPABASE_URL = 'https://fnopntlihakgrydvwdge.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_e59T3yCSuMGmLxunWtdTbw_B1KGGsMs';
const OWNER_ID = 'd08e9b9c-3e14-45f5-8ad0-44df864ff0ee';
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    blocked: { type: 'BOOLEAN', description: 'true only if the question contains or asks about a real patient\'s identifying or medical details' },
    fromNotes: { type: 'STRING', description: 'What the notes say that answers the question (1-5 short sentences, may cite the slide/page). Empty string if the notes do not cover it.' },
    beyondNotes: { type: 'STRING', description: 'Extra answer from general radiologic technology knowledge, only when the notes do not fully answer it. Empty string if not needed.' },
    masterList: { type: 'STRING', description: 'The matching class master list values, copied exactly, only when the question is about one of those projections. Empty string otherwise.' },
    unsure: { type: 'BOOLEAN', description: 'true if the general-knowledge part is uncertain' }
  },
  required: ['blocked', 'fromNotes', 'beyondNotes', 'masterList', 'unsure'],
  propertyOrdering: ['blocked', 'fromNotes', 'beyondNotes', 'masterList', 'unsure']
};
// Compact copy of the class master projection list (radiographic-projections/projections.json).
const CLASS_MASTER_LIST = "Hand PA | CR Perpendicular (0°) | at 3rd MCP joint | rot none\nHand PA Oblique | CR Perpendicular (0°) | at 3rd MCP joint | rot 45°\nHand Lateral | CR Perpendicular (0°) | at 2nd MCP joint | rot none\nWrist PA | CR Perpendicular (0°) | at Midcarpal area | rot none\nWrist PA Oblique | CR Perpendicular (0°) | at Midcarpal area | rot 45°\nWrist Lateral | CR Perpendicular (0°) | at Wrist joint | rot none\nWrist PA Ulnar Deviation | CR Perpendicular (0°) | at Scaphoid | rot none\nFingers PA | CR Perpendicular (0°) | at PIP joint | rot none\nFingers PA Oblique | CR Perpendicular (0°) | at PIP joint | rot 45°\nFingers Lateral | CR Perpendicular (0°) | at PIP joint | rot none\nThumb AP | CR Perpendicular (0°) | at 1st MCP joint | rot none\nThumb PA Oblique | CR Perpendicular (0°) | at 1st MCP joint | rot 45°\nThumb Lateral | CR Perpendicular (0°) | at 1st MCP joint | rot none\nForearm AP | CR Perpendicular (0°) | at Mid-forearm | rot none\nForearm Lateral | CR Perpendicular (0°) | at Mid-forearm | rot none\nElbow AP | CR Perpendicular (0°) | at Elbow joint | rot none\nElbow AP Oblique (Medial Rotation) | CR Perpendicular (0°) | at Elbow joint | rot 45° medial\nElbow AP Oblique (Lateral Rotation) | CR Perpendicular (0°) | at Elbow joint | rot 45° lateral\nElbow Lateral | CR Perpendicular (0°) | at Elbow joint | rot none\nHumerus AP | CR Perpendicular (0°) | at Mid-humerus | rot none\nHumerus Lateral | CR Perpendicular (0°) | at Mid-humerus | rot none\nShoulder AP (External Rotation) | CR Perpendicular (0°) | at 1 inch inferior to coracoid process | rot none\nShoulder AP Oblique (Grashey Method) | CR Perpendicular (0°) | at 2 inches medial and 2 inches inferior to the superolateral border | rot 35–45°\nShoulder Inferosuperior Axial | CR 15–30° cephalic | at Through the axilla to the AC joint | rot none\nScapula AP | CR Perpendicular (0°) | at Mid-scapula (2 inches inferior to coracoid process) | rot none\nScapula Lateral | CR Perpendicular (0°) | at Mid-medial scapular border | rot 45–60°\nClavicle AP | CR Perpendicular (0°) | at Midshaft | rot none\nClavicle AP Axial | CR 15–30° cephalic | at Midshaft | rot none\nAC Joint AP (Pearson Method) | CR Perpendicular (0°) | at MSP at the level of the AC joint | rot none\nToes AP Axial | CR 15° posteriorly (toward the heel) | at 3rd MTP joint | rot none\nToes AP Oblique (Medial Rotation) | CR Perpendicular (0°) | at 3rd MTP joint | rot 30–45°\nToes Lateral | CR Perpendicular (0°) | at IP joint of the great toe / PIP joint of the lesser toes | rot none\nFoot AP Axial | CR 10° toward the heel (posteriorly) | at Base of the third metatarsal | rot none\nFoot AP Oblique (Medial Rotation) | CR Perpendicular (0°) | at Base of the third metatarsal | rot 30°\nFoot Lateral (Mediolateral) | CR Perpendicular (0°) | at Base of the first metatarsal | rot none\nCalcaneus Axial (Plantodorsal) | CR 40° cephalic (toward the heel) | at Entering the base of the third metatarsal | rot none\nCalcaneus Lateral (Mediolateral) | CR Perpendicular (0°) | at 1 inch distal to the medial malleolus | rot none\nAnkle AP | CR Perpendicular (0°) | at Ankle joint, midway between the malleoli | rot none\nAnkle AP Oblique (Medial Rotation) Mortise | CR Perpendicular (0°) | at Ankle joint, midway between the malleoli | rot 15–20° internal\nAnkle AP Oblique (Lateral Rotation) | CR Perpendicular (0°) | at Ankle joint, midway between the malleoli | rot 45° lateral\nAnkle Lateral (Mediolateral) | CR Perpendicular (0°) | at Medial malleolus | rot none\nLower Leg AP | CR Perpendicular (0°) | at Midpoint of lower leg/tib/fib | rot none\nLower Leg Lateral | CR Perpendicular (0°) | at Midpoint of lower leg/tib/fib | rot none\nKnee AP | CR Based on ASIS-to-tabletop measurement: <19 cm = 3–5° caudal; 19–24 cm = perpendicular; >24 cm = 3–5° cephalic | at 1/2 inch inferior to the patellar apex | rot none\nKnee AP Oblique (Medial Rotation) | CR Based on ASIS-to-tabletop measurement: <19 cm = 3–5° caudal; 19–24 cm = perpendicular; >24 cm = 3–5° cephalic (same ASIS rules as Knee AP) | at 1/2 inch inferior to the patellar apex | rot 45° medial | CR given in source as 'same ASIS rules'; written out from Knee AP\nKnee AP Oblique (Lateral Rotation) | CR Based on ASIS-to-tabletop measurement: <19 cm = 3–5° caudal; 19–24 cm = perpendicular; >24 cm = 3–5° cephalic (same ASIS rules as Knee AP) | at 1/2 inch inferior to the patellar apex | rot 45° lateral | CR given in source as 'same ASIS rules'; written out from Knee AP\nKnee Lateral | CR 5–7° cephalic | at 1 inch distal to the medial femoral epicondyle | rot none\nKnee Tangential (Settegast/Sunrise) | CR 15–20° cephalic | at Patellofemoral joint space | rot none\nPatella PA | CR Perpendicular (0°) | at Mid-popliteal area, exiting the patella | rot Usually 5–10° lateral rotation of the heel\nPatella Lateral | CR Perpendicular (0°) | at Mid-patellofemoral joint | rot none\nPatella Tangential (Settegast/Sunrise) | CR 15–20° cephalic | at Patellofemoral joint space | rot none\nFemur AP | CR Perpendicular (0°) | at Mid-femur | rot none\nFemur Lateral | CR Perpendicular (0°) | at Mid-femur | rot none\nPelvis AP | CR Perpendicular (0°) | at Midway between ASIS and pubic symphysis (2 inches inferior to ASIS / 2 inches superior to pubic symphysis) on MSP | rot Medially rotate feet 15–20°\nPelvis AP Oblique (Modified Cleaves / Bilateral Frog Leg) | CR Perpendicular (0°) | at Bilateral: 1 inch superior to pubic symphysis on MSP; Unilateral: femoral neck | rot Abduct thighs 45° if possible | non-routine/trauma\nHip AP Pelvis | CR Perpendicular (0°) | at Midway between ASIS and pubic symphysis (2 inches inferior to ASIS / 2 inches superior to pubic symphysis) on MSP | rot Medially rotate feet 15–20° | Source: 'same as Pelvis AP'; values copied from Pelvis AP\nHip AP Oblique (Modified Cleaves / Frog Leg) | CR Perpendicular (0°) | at Bilateral: 1 inch superior to pubic symphysis on MSP; Unilateral: femoral neck | rot Abduct thighs 45° if possible | non-routine/trauma | Source: 'same as above'; values copied from Pelvis AP Oblique (Modified Cleaves / Bilateral Frog Leg)\nHip AP | CR Perpendicular (0°) | at 2.5 inches distal on line perpendicular to midpoint of ASIS–pubic symphysis line (femoral neck) | rot Medially rotate 15–20°\nHip Lateral (Lauenstein) | CR Perpendicular (0°) | at Through hip joint, midway between ASIS and pubic symphysis | rot none\nHip Axiolateral (Danelius-Miller / X-table) | CR Horizontal, perpendicular to long axis of femoral neck | at Enters groin midway, 2.5 inches below localization lines | rot none | non-routine/trauma\nHip Modified Axiolateral (Clements-Nakayama) | CR Perpendicular (0°); tube angled 15° posteriorly | at Femoral neck | rot Neutral or external rotation | non-routine/trauma | v1.1: CR and location corrected per user\nSoft Tissue Neck AP | CR Perpendicular (0°) | at MSP at laryngeal prominence (C4) or manubrium | rot none\nSoft Tissue Neck Lateral | CR Horizontal and perpendicular (0°) | at MCP at laryngeal prominence (C4) or jugular notch level | rot none\nChest PA | CR Perpendicular (0°) | at MSP at T7 (inferior angle of scapula) | rot none\nChest Lateral (Left preferred) | CR Perpendicular (0°) | at MCP at T7 | rot none\nChest Portable AP | CR Perpendicular (0°) | at MSP at T7 (3 inches below jugular notch) | rot none\nSternum PA Oblique (RAO) | CR Perpendicular (0°) | at Elevated side at T7, ~1 inch lateral to MSP | rot RAO 15–20°\nSternum Lateral | CR Perpendicular (0°) | at Lateral border of mid-sternum | rot none\nSternoclavicular Articulations PA | CR Perpendicular (0°) | at MSP at T3 | rot none\nSternoclavicular Articulations PA Oblique | CR Perpendicular (0°) | at T2–T3 level, 1–2 inches lateral to MSP toward side up | rot RAO/LAO 10–15°\nRibs PA Chest | CR Perpendicular (0°) | at MSP at T7 | rot none\nRibs AP/PA above diaphragm | CR Perpendicular (0°) | at MSP ~T7 | rot none\nRibs AP/PA below diaphragm | CR Perpendicular (0°) | at MSP halfway between xiphoid and lower rib margin | rot none\nRibs AP Oblique | CR Perpendicular (0°) | at Halfway between MSP and lateral surface of body side up (T7 upper / xiphoid–lower margin lower) | rot 45° RPO/LPO\nCervical Spine Lateral (Grandy) | CR Horizontal and perpendicular (0°) | at Coronal plane through mastoid tip at C4 | rot none\nCervical Spine AP Axial | CR 15–20° cephalad | at Through C4 (near thyroid cartilage) | rot none\nCervical Spine AP Open Mouth | CR Perpendicular (0°) | at Midpoint of open mouth at axis level | rot none\nCervical Spine AP Axial Oblique | CR 15–20° cephalic | at To C4 | rot 45° RPO/LPO\nCervical Spine Swimmer’s | CR Perpendicular (0°) (or 3–5° caudal) | at C7–T1 disk space | rot none | non-routine/trauma\nCervical Spine AP Dens (Fuchs) | CR Perpendicular (0°) | at MSP at mastoid tips just distal to chin tip | rot none | non-routine/trauma\nCervical Spine Lateral Hyperflexion/Hyperextension | CR Horizontal and perpendicular (0°) | at To C4 | rot none | non-routine/trauma\nThoracic Spine AP | CR Perpendicular (0°) | at MSP halfway between jugular notch and xiphoid (~T7) | rot none\nThoracic Spine Lateral | CR Perpendicular (0°) if spine is horizontal; if the vertebral column is not elevated to a horizontal plane in the recumbent position, 10° cephalic for females / 15° cephalic for males | at Posterior half of thorax at T7 | rot none\nThoracic Spine Cervicothoracic Region Lateral (Swimmer's Technique) | CR Perpendicular (0°) (or 3–5° caudal) | at C7–T1 disk space | rot none | Routine for thoracic spine; values copied from Cervical Swimmer’s\nThoracic Spine AP Oblique | CR Perpendicular (0°) | at Exiting T7 | rot 20° posterior | non-routine/trauma\nScoliosis Series PA | CR Perpendicular (0°) | at Midpoint of IR | rot none\nLumbar Spine AP | CR Perpendicular (0°) | at Iliac crest (lumbosacral) or 1.5 inches above (lumbar only) | rot none\nLumbar Spine Left Lateral | CR Perpendicular (0°) | at Same as AP | rot none\nLumbar Spine Lateral L5-S1 Spot | CR Perpendicular (0°) if horizontal; else 8° caudal women / 5° caudal men | at 2 inches posterior to ASIS and 1.5 inches inferior to iliac crest | rot none\nLumbar Spine AP Oblique | CR Perpendicular (0°) | at 2 inches medial to elevated ASIS + 1.5 inches above crest (or midway for L5-S1) | rot 45° RPO/LPO | non-routine/trauma\nSI Joints AP Axial (Ferguson) | CR 30° cephalic male / 35° female | at MSP 2–2.5 inches inferior to ASIS | rot none\nSI Joints AP Oblique | CR Perpendicular (0°) | at 1 inch medial to elevated ASIS | rot RPO/LPO 25–30°\nSacrum/Coccyx Sacrum AP Axial Supine | CR 15° cephalic | at MSP 2 inches superior to pubic symphysis | rot none\nSacrum/Coccyx Sacrum AP Axial Prone | CR 15° caudal | at Level of sacral curve | rot none\nSacrum/Coccyx Coccyx AP Axial Supine | CR 10° caudal | at MSP 2 inches superior to pubic symphysis | rot none\nSacrum/Coccyx Coccyx AP Axial Prone | CR 10° cephalic | at Level of palpable coccyx | rot none\nSacrum/Coccyx Sacrum Lateral | CR Perpendicular (0°) | at 3.5 inches posterior to ASIS | rot none\nSacrum/Coccyx Coccyx Lateral | CR Perpendicular (0°) | at 3.5 inches posterior and 2 inches inferior to ASIS | rot none\nSacrum/Coccyx Both Lateral | CR Perpendicular (0°) | at 3.5 inches posterior to ASIS and 1 inch inferior to ASIS | rot none\nAbdomen PA Chest | CR Perpendicular (0°) | at MSP at T7 | rot none\nAbdomen AP Upright | CR Horizontal and perpendicular (0°) | at 2 inches above iliac crest on MSP | rot none\nAbdomen AP Supine KUB | CR Perpendicular (0°) | at Iliac crest on MSP | rot none\nAbdomen PA/AP High Transverse | CR Perpendicular (0°) | at Halfway between xiphoid and lower rib margin on MSP | rot none\nEsophagus PA/AP Oblique Swallow | CR Perpendicular (0°) | at 2 inches lateral to MSP at T5–T6 on elevated side | rot RAO/LPO 35–40°\nEsophagus Lateral Swallow | CR Perpendicular (0°) | at MCP at T5–T6 | rot none\nEsophagus AP/PA Swallow | CR Perpendicular (0°) | at MSP at T5–T6 | rot none | non-routine/trauma\nUGI PA/AP | CR Perpendicular (0°) | at 1–2 inches above lower rib margin, midway between vertebral column and left lateral abdomen | rot none\nUGI Lateral (Right) | CR Perpendicular (0°) | at 1–2 inches above lower rib margin, midway between MCP and anterior abdomen | rot none\nUGI PA Oblique (RAO) | CR Perpendicular (0°) | at 1–2 inches above lower rib margin on elevated side | rot RAO 40–70°\nUGI AP Oblique (LPO) | CR Perpendicular (0°) | at Midway between xiphoid and lower rib margin on elevated side | rot LPO 30–60° | non-routine/trauma";
const POSITIONING_RE = /\b(projections?|views?|position(ing|ed)?|cr\b|central ray|angle[ds]?|cephal\w*|caud\w*|rotat\w*|obliques?|lateral|\bap\b|\bpa\b|axial|tangential|center(ed|ing)?|centr\w*|perpendicular|degrees?|°|hand|wrist|finger|thumb|forearm|elbow|humerus|shoulder|scapula|clavicle|ac joint|toes?|foot|feet|calcaneus|ankle|leg|knee|patella|femur|pelvis|hip|chest|sternum|sternoclavicular|ribs?|spine|cervical|thoracic|lumbar|sacrum|coccyx|si joints?|abdomen|kub|esophag\w*|stomach|ugi|small bowel|barium|enema)\b/i;

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
  const master = POSITIONING_RE.test(question);
  return [
    'You are a friendly tutor answering a radiologic technology student\'s question about their class notes. Keep everything short and in simple words.',
    'Fill three separate parts and never mix them:',
    '1) fromNotes: answer from the SECTION NOTES first (and the OTHER NOTES FROM THE SAME FILE if given). Use only what the notes say; you may mention the slide/page. Never change a fact. If the notes do not cover it, use an empty string.',
    '2) beyondNotes: only if the notes do not cover the question, or only partly cover it (or the student explicitly asks beyond the notes), give a short answer (1-4 sentences) from standard radiologic technology knowledge: positioning, anatomy, physiology, physics, procedures, patient care, textbook-level facts. Otherwise use an empty string. Do not repeat what fromNotes says.',
    master ? '3) masterList: if the question is about one of the projections in the CLASS MASTER LIST below, copy its values exactly (projection, CR angle/direction, CR location, rotation). Otherwise use an empty string. Never put master list values in fromNotes.' : '3) masterList: use an empty string.',
    'Rules: Do NOT invent citations, book or article titles, authors, page numbers of books, or URLs, and do not claim to have searched anything. Do not invent numbers or angles. If you are not sure about the general-knowledge part, say so plainly in beyondNotes and set unsure to true. You may use **double asterisks** for key terms.',
    'If the question includes or asks about a real patient (names, dates of birth, MRNs, a specific person\'s case or images), set blocked to true, leave fromNotes and masterList empty, and in beyondNotes say kindly that you can\'t help with patient information and they should ask about the topic in general instead.',
    '',
    'STUDENT QUESTION: ' + question,
    notesBlock(text, 'SECTION NOTES'),
    context ? notesBlock(context, 'OTHER NOTES FROM THE SAME FILE') : '',
    master ? notesBlock('Columns: body part + projection | CR angle/direction | CR location | body part rotation | flags/notes\n' + CLASS_MASTER_LIST, 'CLASS MASTER LIST') : ''
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
  if (cors.tally) cors.tally.push('gemini:' + models[mi]); // per-request list, counted after the response
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
          for (const v of d.violations || []) {
            if (/PerDay/i.test(v.quotaId || '')) perDay = true;
            // Google puts the real limit in the 429 ("quotaValue"); keep it for the usage page.
            if (cors.quota && v.quotaId && v.quotaValue) cors.quota.push({ model: (v.quotaDimensions && v.quotaDimensions.model) || '', id: String(v.quotaId).slice(0, 120), value: String(v.quotaValue).slice(0, 20) });
          }
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

// ---- 'projections': positioning projections described in the notes (no outside knowledge) ----
const NOS = 'not on slides';
const MAX_PROJECTIONS = 60;
const PROJ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    projections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Projection name as the notes say it, e.g. "AP Ankle", "Lateral L-spine"' },
          bodyPart: { type: 'STRING', description: 'Body part / exam, e.g. "Ankle", or "not on slides"' },
          crAngleDirection: { type: 'STRING', description: 'Central ray angle and direction exactly as stated, e.g. "Perpendicular" or "15° cephalad", or "not on slides"' },
          crLocation: { type: 'STRING', description: 'Where the central ray is centered / enters, as stated, or "not on slides"' },
          rotation: { type: 'STRING', description: 'Body part / patient rotation or obliquity as stated, e.g. "15–20° medial rotation", or "not on slides"' },
          notes: { type: 'STRING', description: 'Optional short extra detail stated in the notes (under 120 characters), or ""' },
          sourceHint: { type: 'STRING', description: 'Slide/page it came from, e.g. "Slide 12" or "Slides 3, 7"; "" if the notes have no slide markers' },
          nonRoutine: { type: 'BOOLEAN', description: 'true ONLY if the notes call it trauma, non-routine, special, optional or supplemental' }
        },
        required: ['name', 'bodyPart', 'crAngleDirection', 'crLocation', 'rotation', 'notes', 'sourceHint', 'nonRoutine'],
        propertyOrdering: ['name', 'bodyPart', 'crAngleDirection', 'crLocation', 'rotation', 'notes', 'sourceHint', 'nonRoutine']
      }
    }
  },
  required: ['projections']
};

function buildProjectionsPrompt(text) {
  return [
    'You read a radiologic technology student\'s class notes (slide text). Each slide starts with a marker like "--- Slide 12 ---" (or "--- Page 3 ---" / "--- Photo 2 ---"). List every radiographic PROJECTION (a named positioning view of a body part, e.g. "AP ankle", "PA oblique hand", "lateral L-spine") that the notes describe.',
    'STRICT RULES:',
    '- Copy ONLY what the notes state. Never fill in a field from your own knowledge, a textbook, or what is "usually" done, even if you are sure. If a field is not stated in the notes, write exactly "not on slides".',
    '- Keep the notes\' own wording, numbers and units (inches, cm, degrees). Never invent, convert or round a measurement or angle.',
    '- crAngleDirection = the central ray (CR) angle and its direction (e.g. "Perpendicular", "15° cephalad", "10° caudal"). crLocation = where the CR is centered or enters. rotation = how much the body part or patient is rotated/obliqued (e.g. "45° medial rotation"); if the notes say there is no rotation, write what they say; if rotation is not mentioned, "not on slides".',
    '- A slide that names a projection but gives no CR details still counts: list it with "not on slides" for the missing fields.',
    '- The same projection on several slides is ONE entry: merge the fields and list all its slides in sourceHint. Treat cephalic = cephalad and caudal = caudad as the same.',
    '- nonRoutine is true ONLY when the notes call the projection trauma, non-routine, special, optional or supplemental; otherwise false.',
    '- notes: optional, a short fact from the notes about this projection (e.g. what it shows); "" if none. Do not repeat the other fields.',
    '- If the notes contain no projections (vocabulary, terminology, anatomy, physics, patient care, etc.), return an empty list. Do not turn anatomy terms or general rules into projections.',
    '',
    'NOTES:',
    '"""',
    text,
    '"""'
  ].join('\n');
}

// Numbers stated in the notes ("third" counts as 3), so the Worker can drop any value with a number the notes never mention.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, half: 2 };
function numbersIn(str) {
  const s = String(str || '').toLowerCase();
  const out = new Set((s.match(/\d+(?:\.\d+)?/g) || []).map(n => String(Number(n))));
  s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|half)\b/g, w => { out.add(String(NUM_WORDS[w])); if (w === 'half') out.add('1'); return w; });
  return out;
}
function isNos(v) { return !v || /^(not (on|in) (the )?(slides?|notes)|not stated|not given|n\/?a|unknown|none given)\.?$/i.test(String(v).trim()); }
const PROJ_STOP = new Set(['projection', 'projections', 'view', 'views', 'the', 'of', 'and', 'a', 'an', 'for', 'position', 'method']);
function projWords(str) {
  return String(str || '').toLowerCase()
    .replace(/\bceph(?:alic|alad)\b/g, 'cephalad').replace(/\bcaud(?:al|ad)\b/g, 'caudad')
    .replace(/\blat\b/g, 'lateral').replace(/\bobl\b/g, 'oblique')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !PROJ_STOP.has(w));
}
function projKey(p) {
  const nm = projWords(p.name), bp = isNos(p.bodyPart) ? [] : projWords(p.bodyPart);
  const words = new Set(nm);
  for (const w of bp) words.add(w);
  return [...words].sort().join(' ');
}
function slideNums(h) { return (String(h || '').match(/\d+/g) || []).map(Number); }
function mergeHints(a, b) {
  const word = (/\b(page|photo)s?\b/i.exec(a + ' ' + b) || [null, 'slide'])[1].toLowerCase();
  const nums = [...new Set(slideNums(a).concat(slideNums(b)))].sort((x, y) => x - y);
  if (!nums.length) return cleanStr(a || b, 80);
  const W = word[0].toUpperCase() + word.slice(1);
  return nums.length === 1 ? W + ' ' + nums[0] : W + 's ' + nums.join(', ');
}
function sanitizeProjections(list, text) {
  if (!Array.isArray(list)) return [];
  const textNums = numbersIn(text);
  const perp = /perpendicular|\bperp\b/i.test(text);
  const lowText = ' ' + projWords(text).join(' ') + ' ';
  const grounded = v => [...numbersIn(v)].every(n => textNums.has(n) || ((n === '0' || n === '90') && perp));
  const field = (v, max) => { const t = cleanStr(v, max); return isNos(t) || !grounded(t) ? NOS : t; };
  const byKey = new Map();
  for (const raw of list.slice(0, MAX_PROJECTIONS * 2)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanStr(raw.name, 120);
    if (!name || isNos(name)) continue;
    // The projection's own words must be in the notes (stops a "standard" view the notes never mention).
    const nw = projWords(name).filter(w => w.length > 1);
    const found = nw.filter(w => lowText.includes(' ' + w + ' ')).length;
    if (!nw.length || found / nw.length < 0.5) continue;
    let notes = cleanStr(raw.notes, 200);
    if (isNos(notes) || !grounded(notes)) notes = '';
    const p = {
      name,
      bodyPart: field(raw.bodyPart, 80),
      crAngleDirection: field(raw.crAngleDirection, 200),
      crLocation: field(raw.crLocation, 240),
      rotation: field(raw.rotation, 160),
      notes,
      sourceHint: cleanStr(raw.sourceHint, 80).replace(/^(not on slides|n\/a)$/i, ''),
      nonRoutine: raw.nonRoutine === true
    };
    const k = projKey(p);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, p); continue; }
    for (const f of ['bodyPart', 'crAngleDirection', 'crLocation', 'rotation']) if (prev[f] === NOS && p[f] !== NOS) prev[f] = p[f];
    if (p.notes && !prev.notes.toLowerCase().includes(p.notes.toLowerCase())) prev.notes = cleanStr(prev.notes ? prev.notes + ' ' + p.notes : p.notes, 200);
    prev.sourceHint = mergeHints(prev.sourceHint, p.sourceHint);
    prev.nonRoutine = prev.nonRoutine || p.nonRoutine;
  }
  return [...byKey.values()].slice(0, MAX_PROJECTIONS);
}

// ---------------- Usage counting ----------------
// One Durable Object instance ("global") holds a tiny SQLite table: (hour bucket UTC, key) -> count.
// Each Worker request = 1 DO call + 1 upsert per key (usually 2-3 small rows). Atomic, no lost increments.
export class UsageCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS counts (hour TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour, k)) WITHOUT ROWID');
    // Limits Google reported in 429 responses (quotaId + model -> value), newest wins.
    this.sql.exec('CREATE TABLE IF NOT EXISTS quotas (model TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, seen TEXT NOT NULL, PRIMARY KEY (model, id)) WITHOUT ROWID');
  }
  add(hour, keys, quotas) {
    for (const k of keys) this.sql.exec('INSERT INTO counts (hour, k, n) VALUES (?, ?, 1) ON CONFLICT (hour, k) DO UPDATE SET n = n + 1', hour, k);
    for (const q of quotas || []) this.sql.exec('INSERT INTO quotas (model, id, value, seen) VALUES (?, ?, ?, ?) ON CONFLICT (model, id) DO UPDATE SET value = excluded.value, seen = excluded.seen', q.model, q.id, q.value, new Date().toISOString());
  }
  // Sums per key over [fromHour, now]. Hour strings are 'YYYY-MM-DDTHH' (UTC), so they sort as text.
  sums(fromHour) {
    const out = {};
    for (const r of this.sql.exec('SELECT k, SUM(n) AS n FROM counts WHERE hour >= ? GROUP BY k', fromHour)) out[r.k] = r.n;
    return out;
  }
  report(bounds) {
    const out = {};
    for (const name of Object.keys(bounds)) out[name] = this.sums(bounds[name]);
    const first = [...this.sql.exec('SELECT MIN(hour) AS h FROM counts')][0];
    out.countingSince = first && first.h ? first.h + ':00Z' : null;
    out.googleQuotas = [...this.sql.exec('SELECT model, id, value, seen FROM quotas ORDER BY model, id')].map(r => ({ model: r.model, id: r.id, value: r.value, seen: r.seen }));
    return out;
  }
}

const hourKey = d => d.toISOString().slice(0, 13);
// Start of "today" in America/Los_Angeles (Gemini's daily quota resets at midnight Pacific), as a UTC hour key.
function pacificMidnightHour(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(now).map(p => [p.type, p.value]));
  const hoursSinceMidnight = parseInt(parts.hour, 10) % 24;
  return hourKey(new Date(Math.floor(now.getTime() / 3600000) * 3600000 - hoursSinceMidnight * 3600000));
}

function counter(env) {
  return env.USAGE ? env.USAGE.get(env.USAGE.idFromName('global')) : null;
}

function recordUsage(env, ctx, keys, quotas) {
  const c = counter(env);
  if (!c || !ctx) return;
  ctx.waitUntil(c.add(hourKey(new Date()), keys, quotas).catch(() => { /* counting must never break the app */ }));
}

async function usageResponse(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!token) return json({ error: 'unauthorized', message: 'This page is private.' }, 401, cors);
  let user = null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token[1], apikey: SUPABASE_PUBLISHABLE_KEY } });
    if (r.ok) user = await r.json();
  } catch (e) { /* treated as unauthorized */ }
  if (!user || !user.id) return json({ error: 'unauthorized', message: 'This page is private.' }, 401, cors);
  if (user.id !== OWNER_ID) return json({ error: 'forbidden', message: 'This page is private.' }, 403, cors);
  const c = counter(env);
  if (!c) return json({ error: 'no_counter', message: 'Usage counter is not bound to this Worker.' }, 500, cors);
  const now = new Date();
  const utcDay = now.toISOString().slice(0, 10) + 'T00';
  const utcMonth = now.toISOString().slice(0, 7) + '-01T00';
  const data = await c.report({ todayUtc: utcDay, todayPacific: pacificMidnightHour(now), monthUtc: utcMonth, last30d: hourKey(new Date(now.getTime() - 30 * 86400000)) });
  return json(Object.assign({ ok: true, now: now.toISOString(), model: MODEL, fallbackModel: FALLBACK_MODEL }, data), 200, Object.assign({}, cors, { headers: Object.assign({ 'Cache-Control': 'no-store' }, cors.headers) }));
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    cors.tally = []; cors.quota = [];
    let res, label = 'other';
    try {
      const r = await handle(request, env, cors);
      res = r.res; label = r.label || label;
    } catch (e) {
      console.error('worker error', e && e.stack || e);
      label = 'error';
      res = json({ error: 'server', message: 'Something went wrong in the Worker. Try again.' }, 500, cors);
    }
    recordUsage(env, ctx, ['req:' + label, ...cors.tally], cors.quota);
    return res;
  }
};

async function handle(request, env, cors) {
  const r = await route(request, env, cors);
  return r instanceof Response ? { res: r, label: cors.label } : r;
}

async function route(request, env, cors) {
    const origin = request.headers.get('Origin') || '';
    cors.label = request.method.toLowerCase();
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
    }
    if (request.method === 'GET' && new URL(request.url).searchParams.get('action') === 'usage') {
      cors.label = 'usage';
      return usageResponse(request, env, cors);
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
    if (ACTIONS.includes(action)) cors.label = action === 'explain' ? (body.style === 'detail' ? 'explain:detail' : 'explain:simple') : action;
    else cors.label = 'bad_action';
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

    // ---- Projections: positioning facts copied from the notes (temperature 0, nothing filled in) ----
    if (action === 'projections') {
      const r = await callGemini(env, cors, buildProjectionsPrompt(text), PROJ_SCHEMA, { temperature: 0, maxOutputTokens: 16384 });
      if (r.error) return r.error;
      const projections = sanitizeProjections(r.parsed && (Array.isArray(r.parsed) ? r.parsed : r.parsed.projections), text);
      return json({ projections, model: MODEL }, 200, cors);
    }

    // ---- Learn mode: "Ask a question" (notes first, then labeled general knowledge / class master list) ----
    const question = cleanStr(body.question, MAX_QUESTION_CHARS);
    if (question.length < 2) return json({ error: 'no_question', message: 'Type a question first.' }, 400, cors);
    let context = typeof body.context === 'string' ? body.context.trim() : '';
    if (text.length + context.length > MAX_TEXT_CHARS) context = context.slice(0, Math.max(0, MAX_TEXT_CHARS - text.length));
    const r = await callGemini(env, cors, buildAskPrompt(text, question, context), ASK_SCHEMA, { temperature: 0.3, maxOutputTokens: 4096 });
    if (r.error) return r.error;
    const pr = r.parsed || {};
    const blocked = pr.blocked === true;
    let fromNotes = blocked ? '' : cleanText(pr.fromNotes, 3000);
    if (fromNotes.length < 200 && /\b(not|isn'?t|aren'?t|doesn'?t|don'?t)\b[^.]*\b(covered|mentioned|discussed|included|say|stated|cover)\b/i.test(fromNotes) && !/\bslide|page\b/i.test(fromNotes)) fromNotes = ''; // "not in your notes" is not an answer
    const beyondNotes = cleanText(pr.beyondNotes, 3000);
    const masterList = blocked ? '' : cleanText(pr.masterList, 1500);
    if (!fromNotes && !beyondNotes && !masterList) return json({ error: 'empty', message: 'Gemini did not send an answer. Try again.' }, 502, cors);
    // 'answer' + 'inNotes' kept for older pages.
    const answer = fromNotes || beyondNotes || masterList;
    return json({ question, fromNotes, beyondNotes, masterList, unsure: pr.unsure === true, blocked, answer, inNotes: !!fromNotes, model: MODEL }, 200, cors);
}
