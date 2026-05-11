const express   = require('express');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

if (!process.env.INTERCOM_CLIENT_SECRET) {
  // Warn loudly — all POST endpoints are open without this secret
  console.warn('WARNING: INTERCOM_CLIENT_SECRET not set — add it to Render environment variables');
}

// Native fetch (Node 18+) or node-fetch fallback
let _fetchFn = null;
const fetch  = globalThis.fetch
  ? (url, opts) => globalThis.fetch(url, opts)
  : (...args) => (_fetchFn
      ? _fetchFn(...args)
      : import('node-fetch').then(({ default: fn }) => { _fetchFn = fn; return fn(...args); }));

// Notion fetch wrapper with 10s timeout — prevents indefinite hangs under Notion outage
const NOTION_TIMEOUT_MS = 10_000;
function notionFetch(url, opts = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const app = express();
// Trust Render's reverse proxy so express-rate-limit reads the real client IP from X-Forwarded-For
app.set('trust proxy', 1);
// helmet hardened for a JSON API served cross-origin by Intercom Canvas Kit:
// - crossOriginResourcePolicy: cross-origin  → allows Intercom to READ our JSON responses
// - crossOriginEmbedderPolicy: false          → no COEP interference
// - contentSecurityPolicy: false              → CSP irrelevant for pure JSON API endpoints
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

// Rate limit Intercom endpoints: 120 req/min covers 20 agents × 6 req/min each
const intercomLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  skip: () => process.env.NODE_ENV !== 'production',
});
app.use('/intercom/', intercomLimiter);

// Capture raw body for Intercom signature verification; cap at 512 KB
app.use(express.json({
  limit: '512kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// --- Security middleware ---

// Verify that POST requests come from Intercom (Canvas Kit x-body-signature).
// Set INTERCOM_CLIENT_SECRET in env. If the var is absent the check is skipped
// (allows local dev without the secret), but in production it MUST be set.
function verifyIntercomRequest(req, res, next) {
  const secret = (process.env.INTERCOM_CLIENT_SECRET || '').trim(); // trim whitespace from copy-paste
  if (!secret) return next(); // dev mode — no secret configured

  // Intercom sends x-body-signature as plain hex (no "sha256=" prefix)
  const received = (req.headers['x-body-signature'] || '').replace(/^sha256=/, '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || '')
    .digest('hex');

  let valid = false;
  try {
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { /* length mismatch → not equal */ }

  if (!valid) {
    console.warn(`Rejected: sig mismatch | bodyLen=${(req.rawBody || '').length}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Protect debug endpoints — require ?token=<DEBUG_TOKEN> or X-Debug-Token header.
// If DEBUG_TOKEN env var is not set, debug endpoints return 403 (disabled in prod).
function requireDebugToken(req, res, next) {
  const token    = req.query.token || req.headers['x-debug-token'];
  const expected = process.env.DEBUG_TOKEN;
  if (!expected || token !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// --- Debug: store last request / error state ---
let lastInit   = {};
let lastSubmit = {};
let lastError  = {};

// --- Server-side conversation suggestion cache ---
// Keyed by Intercom conversation ID. Survives stored_data round-trip failures.
// Intercom's canvas submit payload uses `canvas.stored_data` (not `canvas_data`),
// and we've seen it be unreliable — this cache is the primary source of truth.
const convSuggestionsCache = new Map();
const CONV_CACHE_MAX = 2000;

// --- Server-side search results cache ---
// Intercom does NOT reliably send stored_data on button clicks.
// We cache the last search state per conversation so feedback votes work.
const convSearchCache = new Map();

function cacheConvSearch(convId, query, articleTitles) {
  if (!convId) return;
  convSearchCache.set(String(convId), { query, articleTitles, rated: {}, ts: Date.now() });
  if (convSearchCache.size > CONV_CACHE_MAX) {
    convSearchCache.delete(convSearchCache.keys().next().value);
  }
}

function getCachedConvSearch(convId) {
  if (!convId) return null;
  const entry = convSearchCache.get(String(convId));
  if (!entry) return null;
  if (Date.now() - entry.ts > 24 * 60 * 60 * 1000) { convSearchCache.delete(String(convId)); return null; }
  return entry;
}

function cacheConvSuggestions(convId, titles, convQuery, ctx, meta) {
  if (!convId) return;
  convSuggestionsCache.set(String(convId), { titles, convQuery, ctx, meta, ts: Date.now() });
  // Evict oldest entries if over limit
  if (convSuggestionsCache.size > CONV_CACHE_MAX) {
    convSuggestionsCache.delete(convSuggestionsCache.keys().next().value);
  }
}

function getCachedConvSuggestions(convId) {
  return convId ? convSuggestionsCache.get(String(convId)) : null;
}

// --- Feedback log + context-aware training scores ---
// feedbackLog: ring buffer of raw events for review/export.
// articleFeedbackScores: per-article vote counts, split by context fingerprint
//   so a 👎 on "Install eSIM" (eSIM already installed) doesn't penalise it
//   for customers who haven't installed yet.
//
// Structure: { [title]: { global: {ups,downs}, ctx: { [fingerprint]: {ups,downs} } } }
const feedbackLog  = [];
const FEEDBACK_MAX = 500;

const articleFeedbackScores = {};

// Scoring constants for the Laplace-smoothed multiplier (applyContextBoosts):
//   sentiment  = (ups - downs) / (ups + downs + SMOOTHING)  → range ≈ -1…+1
//   multiplier = clamp(1 + sentiment × MAX_EFFECT, MIN_MULT, ∞)
// SMOOTHING=5: ~5 votes for 50% effect; 10+ for strong influence.
// MIN_CTX_VOTES: minimum votes in a context bucket before it overrides global.
const FEEDBACK_SMOOTHING  = 5;
const FEEDBACK_MAX_EFFECT = 1.5;
const FEEDBACK_MIN_MULT   = 0.05;
const FEEDBACK_MIN_CTX_VOTES = 2;  // need ≥2 context-specific votes to trust them

// Build a compact fingerprint string from the current suggestion context.
// Used to store / look up context-specific feedback votes.
function buildContextFingerprint(ctx, meta, query, intentsOverride = null) {
  const parts = [];

  if (ctx) {
    // eSIM state (coarsened to 3 buckets)
    const uninstalled = /uninstalled|not_installed|deleted/.test(ctx.esimStatus || '');
    const installed   = !uninstalled && /installed|enabled|active/.test(ctx.esimStatus || '');
    const disabled    = /disabled/.test(ctx.esimStatus || '');
    if (uninstalled)       parts.push('esim:off');
    else if (installed)    parts.push('esim:on');
    else if (disabled)     parts.push('esim:dis');

    if (ctx.partnerSlug)        parts.push(`partner:${ctx.partnerSlug}`);
    if (ctx.isB2B)              parts.push('b2b');
    if (ctx.fraudSuspected)     parts.push('fraud');
    if (ctx.isRestrictedCountry) parts.push('geo:restricted');
    if (ctx.dataExpired)        parts.push('data:expired');
    if (ctx.dataNeverUsed && installed) parts.push('data:never_used');
  }

  // Intents from the conversation text + inbox + tags
  const signalText = [
    query                        || '',
    meta?.inbox_name             || '',
    (meta?.tags || []).join(' '),
  ].join(' ').trim();
  if (signalText) {
    const intents = intentsOverride || detectIntents(signalText);
    if (intents.size) parts.push(`i:${[...intents].sort().join(',')}`);
  }

  return parts.sort().join('|') || 'generic';
}

function feedbackSentimentMultiplier(votes) {
  if (!votes) return 1.0;
  const total = votes.ups + votes.downs;
  if (total === 0) return 1.0;
  const sentiment = (votes.ups - votes.downs) / (total + FEEDBACK_SMOOTHING);
  return Math.max(FEEDBACK_MIN_MULT, 1 + sentiment * FEEDBACK_MAX_EFFECT);
}

// articleTitle: the specific article being rated
// allTitles: all article titles shown in the same set (for context)
function recordFeedback(rating, articleTitle, convQuery, ctx, meta, allTitles) {
  const entry = {
    ts:             new Date().toISOString(),
    rating,                                       // 'up' | 'down'
    rated_article:  articleTitle,                 // specific article rated
    other_articles: allTitles.filter(t => t !== articleTitle),
    conv_query:     convQuery,
    inbox_name:     meta.inbox_name || '',
    tags:           meta.tags       || [],
    ctx_signals:    ctx ? {
      esimStatus:      ctx.esimStatus      || null,
      partnerSlug:     ctx.partnerSlug     || null,
      isIOS:           ctx.isIOS           || false,
      isAndroid:       ctx.isAndroid       || false,
      isB2B:           ctx.isB2B           || false,
      fraudSuspected:  ctx.fraudSuspected  || false,
      planZone:        ctx.planZone        || null,
    } : null,
  };
  feedbackLog.push(entry);
  if (feedbackLog.length > FEEDBACK_MAX) feedbackLog.shift();

  // Update context-aware training scores
  if (!articleFeedbackScores[articleTitle])
    articleFeedbackScores[articleTitle] = { global: { ups: 0, downs: 0 }, ctx: {} };

  const scores      = articleFeedbackScores[articleTitle];
  const fingerprint = buildContextFingerprint(ctx, meta, convQuery);

  // Increment global bucket (broad signal across all contexts)
  if (rating === 'up') scores.global.ups++;
  else                 scores.global.downs++;

  // Increment context-specific bucket — cap at 500 fingerprints per article to bound memory
  const fp = fingerprint.slice(0, 200);
  if (!scores.ctx[fp]) {
    if (Object.keys(scores.ctx).length < 500) scores.ctx[fp] = { ups: 0, downs: 0 };
    else { /* bucket full — only update global */ }
  }
  if (scores.ctx[fp]) {
    if (rating === 'up') scores.ctx[fp].ups++;
    else                 scores.ctx[fp].downs++;
  }

  const ctxMult  = feedbackSentimentMultiplier(scores.ctx[fp]).toFixed(2);
  const globMult = feedbackSentimentMultiplier(scores.global).toFixed(2);
  console.log(`FEEDBACK ${rating.toUpperCase()} | "${articleTitle}" | ctx="${fingerprint}" | ctx_mult=${ctxMult}× global_mult=${globMult}×`);
}

// --- Notion cache ---
let articleCache   = null;
let articleDfCache = null;
let articleByTitle = null;
let cacheExpiry    = 0;
let cacheInflight  = null;
const CACHE_TTL    = 5 * 60 * 1000;

// --- Article cache persistence (eliminates cold-start spinning wheel) ---
const ARTICLES_FILE = path.join(__dirname, 'data', 'articles.json');

function saveArticleCache(articles) {
  const slim = articles.map(a => ({
    title: a.title, category: a.category, keywords: a.keywords,
    extractedKeywords: a.extractedKeywords, url: a.url, pageId: a.pageId,
    _titleLC: a._titleLC, _categoryLC: a._categoryLC, _haystack: a._haystack,
  }));
  const tmp = ARTICLES_FILE + '.tmp';
  fs.mkdir(path.join(__dirname, 'data'), { recursive: true }, () => {
    fs.writeFile(tmp, JSON.stringify(slim), 'utf8', err => {
      if (!err) fs.rename(tmp, ARTICLES_FILE, () => {});
    });
  });
}

function loadArticleCache() {
  try {
    const saved = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8'));
    if (!Array.isArray(saved) || saved.length === 0) return;
    articleCache   = saved.map(a => ({ ...a, content: '' }));
    articleByTitle = new Map(articleCache.map(a => [a.title, a]));
    cacheExpiry    = Date.now(); // stale — background refresh on first request
    console.log(`Loaded ${articleCache.length} articles from disk cache`);
  } catch { /* file absent on first run */ }
}

loadArticleCache();

// Recursively fetch all block text up to MAX_DEPTH levels (handles toggles, callouts, lists, tables)
const MAX_BLOCK_DEPTH = 3;

async function fetchBlocksText(blockId, depth = 0) {
  try {
    const res = await notionFetch(
      `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        },
      }
    );
    const data = await res.json();
    if (!res.ok) return '';

    let text = '';
    const childIds = [];

    for (const block of (data.results || [])) {
      const type = block.type;

      // Inline rich text (paragraphs, headings, bullets, toggles, callouts, quotes…)
      const richText = block[type]?.rich_text || [];
      if (richText.length) text += richText.map(t => t.plain_text).join(' ') + ' ';

      // Table rows: iterate cells
      if (type === 'table_row') {
        for (const cell of (block.table_row?.cells || [])) {
          text += cell.map(t => t.plain_text).join(' ') + ' ';
        }
      }

      // Queue child blocks for next level
      if (block.has_children && depth < MAX_BLOCK_DEPTH) {
        childIds.push(block.id);
      }
    }

    // Fetch children 2 at a time with a small gap to stay within Notion rate limits
    for (let i = 0; i < childIds.length; i += 2) {
      const results = await Promise.all(
        childIds.slice(i, i + 2).map(id => fetchBlocksText(id, depth + 1))
      );
      text += results.join(' ');
      if (i + 2 < childIds.length) await new Promise(r => setTimeout(r, 150));
    }

    return text.toLowerCase();
  } catch {
    return '';
  }
}

let _notionRetryAt = 0; // exponential backoff after Notion failures

async function getArticles() {
  // Stale-while-revalidate: serve cached data immediately, refresh Notion in background.
  if (articleCache) {
    if (Date.now() >= cacheExpiry && !cacheInflight && Date.now() >= _notionRetryAt) {
      cacheInflight = _fetchArticles()
        .catch(err => { _notionRetryAt = Date.now() + 30_000; throw err; })
        .finally(() => { cacheInflight = null; });
    }
    return articleCache;
  }
  // No cache — cold start. Race Notion fetch against 8s deadline so Intercom never spins.
  if (cacheInflight) {
    return Promise.race([
      cacheInflight,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Notion cold-start timeout')), 8_000)),
    ]);
  }
  cacheInflight = _fetchArticles()
    .catch(err => { _notionRetryAt = Date.now() + 30_000; throw err; })
    .finally(() => { cacheInflight = null; });
  return Promise.race([
    cacheInflight,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Notion cold-start timeout')), 8_000)),
  ]);
}

// Build df lookup when articles are loaded — called once per cache warm
function buildDfCache(articles) {
  const N = articles.length;
  const df = {};
  for (const a of articles) {
    const hay = `${a.title} ${a.category} ${a.keywords} ${a.extractedKeywords}`.toLowerCase();
    const words = new Set(hay.match(/\b\w+\b/g) || []);
    for (const w of words) df[w] = (df[w] || 0) + 1;
  }
  // Pre-compute idf weight per word: log10((N+1)/(df+1))+1
  const idf = {};
  for (const [w, d] of Object.entries(df)) {
    idf[w] = Math.log10((N + 1) / (d + 1)) + 1;
  }
  return idf;  // { word: idfWeight }
}

async function _fetchArticles() {
  const results = [];
  let cursor = undefined;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch(
      `https://api.notion.com/v1/databases/${process.env.NOTION_DATABASE_ID}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Notion API error');

    for (const page of data.results) {
      const props = page.properties;
      const titleArr = props.Nom?.title || [];
      const title = titleArr.map(t => t.plain_text).join('').trim();
      if (!title) continue;

      const category = props.Day?.select?.name || '';
      const textArr = props.Text?.rich_text || [];
      const keywords = textArr.map(t => t.plain_text).join(' ').toLowerCase();
      const pageId = page.id.replace(/-/g, '');
      const url = `https://www.notion.so/kolet/${pageId}`;

      const _titleLC    = title.toLowerCase();
      const _categoryLC = category.toLowerCase();
      results.push({ title, category, keywords, content: '', extractedKeywords: '',
        url, pageId: page.id, _titleLC, _categoryLC,
        _haystack: `${_titleLC} ${_categoryLC} ${keywords}`,
      });
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  articleCache   = results;
  articleByTitle = new Map(results.map(a => [a.title, a]));
  articleDfCache = buildDfCache(results);
  cacheExpiry    = Date.now() + CACHE_TTL;
  console.log(`Cached ${results.length} articles`);

  saveArticleCache(results);

  // Fetch page content in background (3 at a time, 300ms gap to avoid rate limits)
  enrichArticleContent(results).catch(err => console.error('Enrichment failed:', err.message));

  return results;
}

// Domain terms we always want to catch even if they appear only once
const DOMAIN_TERMS = new Set([
  // eSIM core
  'esim','sim','apn','iccid','qr','qrcode','oneclick','profile','carrier',
  'imei','sos','greyed','grayed','sparks','lanck','plus','tim','proximus',
  'pin','puk','pin code','puk code','blocked esim','unlock esim','sim locked',
  'installed','detected','uninstall','reinstall','reactivate','disable','enabled','disabled',
  // Connectivity
  'roaming','network','connection','connectivity','coverage','bandwidth','speed','throttle','throttled','signal',
  'restricted','blocked','government','vpn','zone','country','constraint','constraints','egypt','turkey','china',
  // Plans & data
  'plan','bundle','gb','extend','renewal','expire','topup','adapter',
  'locate','find esim','locate esim','secondary','destination',
  // Billing
  'refund','invoice','wallet','koin','koins','billing','payment','credit','balance','reimbursement','cashback',
  // Account
  'login','account','otp','verification','password','subscription','domain','disposable',
  'relay','privaterelay','nperf','consent','terms','conditions','checkbox',
  // Transfers
  'transfer','reassign','reassignment','migrate','migration','defective',
  // Vouchers / loyalty
  'voucher','referral','promo','miles','loyalty','partner','valid','validity','countdown','gift','donation',
  // Devices
  'compatible','compatibility','install','activate','activation',
  'android','iphone','pixel','samsung','huawei','xiaomi','oppo',
  // Misc
  'fraud','b2b','enterprise','convert','unused','remaining','leftover',
  'flying','blue','afklm','airfrance','klm',
  'primary','data sim','primary sim','service','bezahlen','paiement','pagare',
  // VoIP / calls
  'voip','call','calling','appel','appels','appeler','microphone','micro',
  'minutes','ring','speaker','calls tab','international call',
]);

// Words to ignore when scoring
const STOPWORDS = new Set([
  'i','my','me','we','us','you','he','she','they','it','its',
  'the','a','an','and','or','but','if','in','on','at','to','for',
  'of','with','by','from','as','is','are','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','could',
  'should','may','might','not','no','so','than','too','very','just',
  'this','that','these','those','what','which','who','how','when',
  'where','why','get','got','can','also','please','help','hi','hello',
  'need','want','still','already','now','then','about','more','some',
  'am','im','ive','dont','cant','wont','isnt','arent','wasnt',
]);

function extractKeywordsFromContent(content) {
  if (!content) return '';

  const words = content
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Frequency count
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  // Keep domain terms + any word appearing 3+ times
  return Object.entries(freq)
    .filter(([w, n]) => DOMAIN_TERMS.has(w) || n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([w]) => w)
    .join(' ');
}

async function enrichArticleContent(articles) {
  let done = 0;
  for (let i = 0; i < articles.length; i += 3) {
    const batch = articles.slice(i, i + 3);
    await Promise.all(
      batch.map(async (article) => {
        if (!article.content) {
          article.content           = await fetchBlocksText(article.pageId);
          article.extractedKeywords = extractKeywordsFromContent(article.content);
        }
      })
    );
    done += batch.length;
    if (done % 15 === 0 || done === articles.length) {
      console.log(`Enriched ${done}/${articles.length} articles`);
    }
    if (i + 3 < articles.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log('Knowledge base build complete');
  // Rebuild IDF cache now that extractedKeywords are populated
  if (articleDfCache) articleDfCache = buildDfCache(articles);
}

// Customer language → article terms. Each key maps to terms likely in article titles/categories.
// Updated from real Intercom conversation analysis (May 2026).
const SYNONYMS = {
  // ── Billing / money ─────────────────────────────────────────────────────
  refund:       ['money back','reimburse','reimbursement','cashback','cancel','cancelled',
                 'rembours','remboursement','reembolso','rimborso'],
  money:        ['refund','payment','invoice','wallet','credit','koin','koins'],
  payment:      ['invoice','pay','paid','charge','billing','bill','receipt',
                 // German (very common in support: "Wie bezahlt man")
                 'bezahlen','bezahlt','bezahle','bezahlung','zahlen','zahlung',
                 // French / Spanish / Italian
                 'payer','paiement','pago','pagare','betalen','apple pay','google pay',
                 'card','carte','tarjeta','credit card'],
  invoice:      ['receipt','bill','billing','charge','facture','factura','fattura'],
  wallet:       ['credit','credits','balance','koin','koins','top up','topup'],

  // ── eSIM install / setup ─────────────────────────────────────────────────
  install:      ['installation','setup','set up','activate','activation','qr','scan','add esim',
                 'how to install','cant install','cannot install','not installing'],
  // "find / locate eSIM in phone settings" (distinct from install problems)
  locate:       ['find my esim','cant find','cannot find','not showing','not visible','not appearing',
                 'disappeared','where is my esim','see my esim','show esim','secondary sim',
                 'business line','travel sim','mobile data label','which sim is kolet',
                 'find esim','locate esim','see esim','esim not showing','esim disappeared',
                 // Phrase variants with filler words ("the", "my", "it") between tokens
                 "see the esim","find the esim","can't see","cant see","see it in","find it in",
                 "doesn't show","does not show","not showing kolet","showing kolet","show kolet",
                 "it doesn't show","it does not show","no kolet","kolet not showing",
                 // Device label confusion — eSIM shows as Plus/TIM/Orange/Proximus, not "Kolet"
                 'kolet plus','kolet tim','kolet lt','kolet sp','kolet lo','kolet orange',
                 'shows as plus','shows as tim','called plus','called tim','named plus','named tim',
                 'plus sim','tim sim','orange sim','proximus sim','sim called','which is mine',
                 'two sims','two sim cards','which line is','my esim is called'],

  // ── Connectivity ─────────────────────────────────────────────────────────
  connection:   ['connect','connectivity','signal','network','no data','internet','roaming','apn',
                 'not connecting','no service','no internet','not getting service',
                 'sos','sos only','greyed','greyed out','grayed','grayed out','grey toggle',
                 'gray toggle','toggle grey','toggle gray','esim greyed','toggle disabled',
                 'country constraint','specific country','country issue','country problem',
                 'works in some countries','not working in','restricted in','blocked in'],
  internet:     ['connection','data','connectivity','apn','network'],
  slow:         ['speed','slow connection','connectivity','throttle','throttled'],
  roaming:      ['connection','apn','network','abroad','travel','international',
                 'johannesburg','japan','turkey','destination','when i arrive','at destination'],
  sms:          ['otp','verification','code','text message','mms','picture message',
                 'whatsapp','imessage','send message','receive message','phone number',
                 'international calls','appels','llamadas'],

  // ── Transfer / device change ─────────────────────────────────────────────
  transfer:     ['move','switch','reassign','new phone','new device','change device','migrate','migration',
                 'defective','broken','repair','replaced phone','phone broken','faulty','factory reset'],
  // data gifting / donation (distinct from device transfer)
  gift:         ['gift data','gifted','gift my gb','data donation','donate data','wrong email',
                 'recipient','receiver','reciever','regalo','cadeau','gifted to wrong','sent to wrong'],

  // ── Koins / convert unused data ──────────────────────────────────────────
  koins:        ['koin','kolet koins','remaining credit','in-app credit','wallet credit',
                 'crédit restant','utiliser le crédit','use my credit','convert data',
                 'convert unused','unused data','données inutilisées','reconvertir',
                 'how do i use koins','use koins'],
  convert:      ['convert unused','convert data','convert to koins','unused data',
                 'données inutilisées','reconvertir','remaining data','leftover data'],

  // ── Account / login ──────────────────────────────────────────────────────
  login:        ['sign in','log in','otp','password','access','verification','code',
                 // Apple iCloud Private Relay blocks OTP delivery
                 'apple relay','icloud relay','private relay','privaterelay','hide my email',
                 'apple email','icloud email','@privaterelay.appleid.com',
                 'not receiving code','code not received','otp not arriving','no otp'],
  account:      ['login','profile','delete','unsubscribe',
                 // T&C consent checkbox — came up repeatedly
                 'terms and conditions','consent','checkbox','check off','tick the box',
                 'cgv','conditions générales','consentement','terms','conditions',
                 // Blocked/disposable email domain
                 'domain blocked','email blocked','disposable email','blocked email','temporary email',
                 'cant register','cannot register','no registration','signup blocked'],

  // ── Vouchers / promo ─────────────────────────────────────────────────────
  // Key learning: promo code VALIDITY questions are NOT fraud — separate intent
  referral:     ['refer','invite','friend','voucher','code','promo','gift','discount','coupon'],
  voucher:      ['referral','promo','code','gift','discount','coupon',
                 // countdown / validity — distinct from fraud
                 'validity','valid','expire','expiry','when does it start','quand commence',
                 'quando inizia','codice promozionale','axa','insurance voucher',
                 'countdown','starts when','when start'],

  // ── Data plan ────────────────────────────────────────────────────────────
  data:         ['gb','gigabyte','plan','package','usage','extend','bundle',
                 // "ran out / expired" language
                 'expired','plan expired','expiré','caducado','ran out','no more data',
                 'used up','data finished','data ended'],

  // ── App / device ─────────────────────────────────────────────────────────
  crash:        ['crash','bug','app','force close','not opening'],
  esim:         ['sim','profile','qr code','qr','compatible','compatibility'],

  // ── Loyalty / partners ───────────────────────────────────────────────────
  miles:        ['flying blue','afklm','air france','klm','points','loyalty','mileage'],
  partner:      ['travel partner','airline','afklm','air france','flying blue'],

  // ── Government / device restrictions ────────────────────────────────────
  imei:         ['imei blocked','imei ban','imei number','device blocked','government block',
                 'egypt','egyptian','turkey','turkish','registration','nra','btk',
                 'register phone','phone registration','blocked by government',
                 'roaming not available','restricted country'],

  // ── VoIP / in-app calls ───────────────────────────────────────────────────
  // Key learning: French customers say "appels" not "call" — must map both ways
  call:         ['voip','calling','phone call','international call','make a call','place a call',
                 'calls tab','microphone','micro','speaker','sound','ring','ringing','no sound',
                 'cant hear','cannot hear','charged for call','call cost','call minutes','minutes',
                 'appel','appels','appeler','passer un appel','appels internationaux',
                 'how to call','kolet call','call feature','in-app call'],
  voip:         ['call','calling','phone call','international call','appel','appels','appeler',
                 'voice over ip','calls tab','kolet calls','call worldwide'],

  // ── Fraud / blocked accounts ─────────────────────────────────────────────
  blocked:      ['fraud','ban','banned','suspended','disposable','email',
                 'fraudster','stolen','compromised','hacked','hijacked'],
  fraud:        ['scam','suspicious','blocked','fake','disposable',
                 'fraudster','stolen','compromised','unauthorized','fraudulent'],

  // ── PIN / PUK — eSIM locked by PIN or PUK code ───────────────────────────
  pin:          ['puk','pin code','puk code','pin number','blocked esim','esim blocked',
                 'unlock esim','sim locked','activate sim','pin prompt',
                 '1234','0000','wrong pin','enter pin','pin required','puk required',
                 'esim pin','sim pin','locked sim','unlock sim'],
};

// Reverse index: synonym value → parent key (built once at startup)
const SYNONYM_REVERSE = new Map();
for (const [key, syns] of Object.entries(SYNONYMS)) {
  for (const s of syns) SYNONYM_REVERSE.set(s, key);
}

// Regex-based intent detection — more robust than keyword expansion for short/noisy text.
// Works across languages by matching common patterns rather than specific words.
// Covers every IKC article category so no conversation type falls through.
function detectIntents(text) {
  const q = (text || '').toLowerCase();
  const intents = new Set();

  // ── Locate eSIM in settings ───────────────────────────────────────────────
  if (/can.{0,5}(see|find|locat|spot)\b|not?.{0,5}(show|visible|appear|find)\b|ne (trouve|vois) pas|non (trovo|vedo)|no (encuentr|veo)\b|(see|find|locat).{0,20}esim|esim.{0,20}(not|ne|no).{0,15}(show|find|see|visible|appear)|where.{0,15}(is.{0,5})?(my.{0,5})?esim/.test(q))
    intents.add('locate');

  // ── Connectivity / no data / SOS ─────────────────────────────────────────
  if (/(no|without|pas de|keine|sin|senza).{0,15}(internet|data|connection|service|signal|connexion|datos|verbindung)|not.{0,10}(connect|work|get data|receiv)|sos only|greyed.{0,8}out|toggle.{0,8}(grey|gray)|wifi.{0,8}off|no connection/.test(q))
    intents.add('connection');

  // ── Slow / throttled connection ───────────────────────────────────────────
  if (/slow|speed.{0,10}(low|bad|poor)|throttl|limited.{0,8}speed|very.{0,5}slow|lent|langsa|lento|lentas/.test(q))
    intents.add('slow');

  // ── Installation ──────────────────────────────────────────────────────────
  if (/\binstall|\bsetup|\bset up|qr.{0,5}(scan|code)|scan.{0,5}qr|add.{0,5}esim|can.{0,5}t install|activation.{0,10}(mode|stuck)|stuck.{0,10}activat/.test(q))
    intents.add('install');

  // ── Extend / top up data plan ─────────────────────────────────────────────
  if (/\bextend\b|\brenew\b|top.{0,3}up|add.{0,8}(data|gb)|more.{0,5}(data|gb)|refill|recharge|buy.{0,8}(plan|data|gb)|purchase.{0,8}(plan|data)|renouveler|aufladen/.test(q))
    intents.add('extend');

  // ── Data expired / ran out ────────────────────────────────────────────────
  if (/expir|ran.{0,5}out|no.{0,5}more.{0,5}data|used.{0,5}up|data.{0,5}(finish|end|gone|over)|plan.{0,5}(end|finish|over)|expiré|caducado/.test(q))
    intents.add('expired');

  // ── Refund / money back ───────────────────────────────────────────────────
  if (/refund|reimburse|cashback|money.{0,5}back|rembours|reembolso|rimborso|want.{0,10}money|get.{0,10}money/.test(q))
    intents.add('refund');

  // ── Invoice / receipt / billing ───────────────────────────────────────────
  if (/invoice|receipt|billing|facture|factura|fattura|rechnung|need.{0,10}(bill|receipt)|justif/.test(q))
    intents.add('invoice');

  // ── Transfer eSIM / new device ────────────────────────────────────────────
  if (/(new|broken|defect|replac|lost|stolen).{0,15}(phone|device)|reassign|factory.{0,5}reset|transfer.{0,8}esim|move.{0,8}esim|changer.{0,8}téléphone/.test(q))
    intents.add('transfer');

  // ── Account / login / OTP ─────────────────────────────────────────────────
  if (/\blog.{0,4}in\b|\bsign.{0,4}in\b|\botp\b|\bpassword\b|can.{0,5}t.{0,10}(access|log|sign)|verification.{0,8}code|code.{0,8}(not|never).{0,8}(receiv|arriv|sent)/.test(q))
    intents.add('account');

  // ── Delete account / unsubscribe ──────────────────────────────────────────
  if (/delete.{0,8}account|close.{0,8}account|remove.{0,8}account|unsubscribe|cancel.{0,8}account|supprimer.{0,8}compte|eliminar.{0,8}cuenta/.test(q))
    intents.add('delete_account');

  // ── Change email address ──────────────────────────────────────────────────
  if (/change.{0,8}email|new.{0,8}email|update.{0,8}email|wrong.{0,8}email|changer.{0,8}(email|mail)|modifier.{0,8}(email|mail)/.test(q))
    intents.add('change_email');

  // ── Koins / wallet / convert unused data ─────────────────────────────────
  if (/\bkoin|\bwallet\b|convert.{0,10}(data|unused)|unused.{0,8}data|remaining.{0,8}(data|credit)|crédit.{0,8}restant|in.?app.{0,8}credit/.test(q))
    intents.add('koins');

  // ── Voucher / promo / referral ────────────────────────────────────────────
  if (/voucher|promo.{0,5}code|referral|discount|coupon|code.{0,8}(not|doesn.{0,3}t).{0,8}(work|valid)|code.{0,8}invalid|when.{0,15}(start|begin|valid)|validit/.test(q))
    intents.add('voucher');

  // ── Gift / data donation ──────────────────────────────────────────────────
  if (/\bgift\b|donat.{0,8}data|share.{0,8}data|send.{0,8}data|data.{0,8}(to|for).{0,8}(friend|family)|cadeau|regalo/.test(q))
    intents.add('gift');

  // ── Compatibility / adapter ───────────────────────────────────────────────
  if (/\badapter\b|not.{0,8}compatible|incompatible|device.{0,8}(not|doesn.{0,3}t).{0,8}support|support.{0,8}esim|esim.{0,8}support/.test(q))
    intents.add('compatibility');

  // ── VoIP / in-app calls ───────────────────────────────────────────────────
  if (/\bvoip\b|\bcall\b|\bappel|\bappels\b|phone.{0,8}(call|number)|international.{0,8}call|make.{0,8}call|microphone|micro\b/.test(q))
    intents.add('voip');

  // ── Flying Blue / miles / loyalty ────────────────────────────────────────
  if (/flying.{0,5}blue|air.{0,5}france|afklm|\bklm\b|\bmiles\b|\bpoints\b|loyalty|mileage/.test(q))
    intents.add('miles');

  // ── Fraud / blocked account ───────────────────────────────────────────────
  if (/\bfraud\b|\bban(ned)?\b|\bsuspend|blocked.{0,8}account|disposable.{0,8}email|account.{0,8}(ban|block|suspend)/.test(q))
    intents.add('fraud');

  // ── Government / IMEI restrictions ───────────────────────────────────────
  if (/\bimei\b|government.{0,8}(block|restrict)|egypt|turkey|turkish|egyptian|register.{0,8}(phone|device)/.test(q))
    intents.add('government');

  // ── SMS / verification / messaging ───────────────────────────────────────
  if (/\bsms\b|\bmms\b|text.{0,5}message|whatsapp|imessage|send.{0,8}(sms|text|message)|receiv.{0,8}(sms|text|message)|phone.{0,8}number/.test(q))
    intents.add('sms');

  // ── PIN / PUK — eSIM locked by PIN or PUK code ───────────────────────────
  if (/\bpin\b|\bpuk\b|pin.{0,5}(code|number|prompt)|puk.{0,5}(code|number)|blocked.{0,10}(pin|esim|sim)|esim.{0,10}blocked|unlock.{0,10}(esim|sim)|sim.{0,10}lock|enter.{0,10}pin|wrong.{0,10}pin/.test(q))
    intents.add('pin_puk');

  return intents;
}

// Maps Intercom workflow tag text / inbox name patterns → intent labels.
// Checked in addition to regex-based detectIntents() — tags are high-confidence signals.
const TAG_INTENT_MAP = [
  [/locat|find.{0,10}esim|request.*locat/i,        'locate'],
  [/connect|start.?using|no.?internet|no.?data|few.?kb/i, 'connection'],
  [/slow|throttl/i,                                 'slow'],
  [/install|setup|qr/i,                             'install'],
  [/extend|renew|top.?up|more.?data/i,              'extend'],
  [/expir|ran.?out|no.?more.?data/i,                'expired'],
  [/refund|cashback|reimburs/i,                     'refund'],
  [/invoice|receipt|billing|payment/i,              'invoice'],
  [/transfer|reassign|new.?device/i,                'transfer'],
  [/login|sign.?in|otp|password|access/i,           'account'],
  [/delete.?account|unsubscribe/i,                  'delete_account'],
  [/change.?email|email.?address/i,                 'change_email'],
  [/koin|wallet|convert|unused.?data/i,             'koins'],
  [/voucher|promo|referral|discount/i,              'voucher'],
  [/gift|donat|share.?data/i,                       'gift'],
  [/adapter|compat/i,                               'compatibility'],
  [/voip|call/i,                                    'voip'],
  [/flying.?blue|miles|afklm|air.?france/i,         'miles'],
  [/fraud|ban|suspend|block/i,                      'fraud'],
  [/imei|egypt|turkey|government/i,                 'government'],
  [/sms|verification|otp.?not|code.?not/i,          'sms'],
  [/pin|puk|blocked.?esim|unlock.?esim|sim.?lock/i, 'pin_puk'],
];

// Declarative table: [intent, articleFilterFn, injectScore]
// Used by applyContextBoosts to force-inject relevant articles for each detected intent.
const INTENT_INJECT_MAP = [
  ['pin_puk',       a => {
    const t = a._titleLC;
    return t.includes('pin') || t.includes('puk') ||
           (t.includes('blocked') && (t.includes('esim') || t.includes('sim')));
  }, 420],
  ['locate',        a => {
    const t = a._titleLC;
    return t.includes('find') || t.includes('locat') || t.includes('cannot find') || t.includes('cannot see');
  }, 320],
  ['connection',    a => {
    const cat = a._categoryLC;
    const t   = a._titleLC;
    return cat.includes('connect') || cat.includes('start using') ||
           t.includes('apn') || t.includes('no data') || t.includes('no internet') ||
           t.includes('constraint') || t.includes('country');
  }, 300],
  ['slow',          a => {
    const t = a._titleLC;
    return t.includes('slow') || t.includes('constraint') || t.includes('country');
  }, 300],
  ['install',       a => a._categoryLC.includes('install'), 290],
  ['extend',        a => {
    const t = a._titleLC;
    return t.includes('extend') || t.includes('renew') || t.includes('top up') || t.includes('topup');
  }, 290],
  ['expired',       a => {
    const t = a._titleLC;
    return t.includes('extend') || t.includes('renew') || t.includes('expir');
  }, 290],
  ['refund',        a => {
    const cat = a._categoryLC;
    const t   = a._titleLC;
    return cat.includes('refund') || cat.includes('billing') ||
           t.includes('refund') || t.includes('reimburse') || t.includes('cashback');
  }, 290],
  ['invoice',       a => {
    const t = a._titleLC;
    return t.includes('invoice') || t.includes('receipt') || t.includes('billing');
  }, 290],
  ['transfer',      a => {
    const t = a._titleLC;
    return t.includes('reassign') || t.includes('transfer') || t.includes('move') || t.includes('new device');
  }, 290],
  ['account',       a => {
    const cat = a._categoryLC;
    const t   = a._titleLC;
    return cat.includes('account') || cat.includes('login') ||
           t.includes('login') || t.includes('otp') || t.includes('password');
  }, 290],
  ['delete_account', a => {
    const t = a._titleLC;
    return t.includes('delete') || t.includes('unsubscribe');
  }, 290],
  ['change_email',   a => {
    const t = a._titleLC;
    return t.includes('email') || t.includes('transferring account');
  }, 280],
  ['koins',         a => {
    const t = a._titleLC;
    return t.includes('koin') || t.includes('wallet') || t.includes('convert') || t.includes('unused');
  }, 290],
  ['voucher',       a => {
    const t = a._titleLC;
    return t.includes('voucher') || t.includes('promo') || t.includes('referral') || t.includes('discount');
  }, 290],
  ['gift',          a => {
    const t = a._titleLC;
    return t.includes('gift') || t.includes('donat') || t.includes('share data');
  }, 290],
  ['compatibility', a => {
    const t = a._titleLC;
    return t.includes('adapter') || t.includes('compatible') || t.includes('compatibility');
  }, 280],
  ['voip',          a => {
    const t = a._titleLC;
    return t.includes('voip') || t.includes('calling') || t.includes('call');
  }, 310],
  ['miles',         a => {
    const t = a._titleLC;
    return t.includes('flying blue') || t.includes('air france') || t.includes('afklm') || t.includes('miles');
  }, 290],
  ['fraud',         a => {
    const cat = a._categoryLC;
    return cat.includes('fraud') || a._titleLC.includes('fraud');
  }, 290],
  ['government',    a => {
    const t = a._titleLC;
    return t.includes('egyptian') || t.includes('turkish') || t.includes('government') ||
           t.includes('imei') || t.includes('constraint') || t.includes('country');
  }, 300],
  ['sms',           a => {
    const t = a._titleLC;
    return t.includes('sms') || t.includes('otp') || (t.includes('phone') && t.includes('number'));
  }, 280],
];

function sanitizeQuery(raw) {
  if (!raw) return '';
  return raw.replace(/[^\w\s\-']/g, '').trim().toLowerCase();
}

function expandTerms(words, fullQuery) {
  const expanded = new Set(words);
  const conceptBoosts = new Set(); // concepts confirmed by a phrase match → extra scoring weight

  // 1. Phrase-level scan — multi-word phrases carry the most intent signal
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    const phraseHit = syns.some(phrase => phrase.includes(' ') && fullQuery.includes(phrase));
    const keyHit    = fullQuery.includes(key);
    if (phraseHit || keyHit) {
      expanded.add(key);
      syns.forEach(s => expanded.add(s));
      if (phraseHit) conceptBoosts.add(key); // phrase match → will be heavily boosted in scoring
    }
  }

  // 2. Word-level expansion for remaining tokens
  for (const word of words) {
    if (SYNONYMS[word]) {
      SYNONYMS[word].forEach(s => expanded.add(s));
    }
    // Reverse lookup using precomputed index
    const parentKey = SYNONYM_REVERSE.get(word);
    if (parentKey && !expanded.has(parentKey)) {
      expanded.add(parentKey);
      for (const s of (SYNONYMS[parentKey] || [])) expanded.add(s);
    }
  }

  return { terms: Array.from(expanded), boostConcepts: Array.from(conceptBoosts) };
}

// ── RAGFlow-inspired scoring primitives ──────────────────────────────────────
//
// Field-boost table (mirrors RAGFlow's per-field ^N weights):
//   title          → ×10  (most discriminative field)
//   manual keywords → ×5  (like RAGFlow's important_kwd)
//   category       → ×3
//   extracted kws  → ×2
//   body content   → ×1  (noisy; gets an extra 0.5× in the caller)
//
const FIELD_BOOSTS = { title: 10, category: 3, keywords: 5, extkw: 2, content: 1 };

// Count non-overlapping occurrences of term in text (fast indexOf loop)
function countOccurrences(text, term) {
  let n = 0, pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) { n++; pos += term.length; }
  return n;
}

// BM25-style TF-IDF field scoring.
// TF saturation (k1=1.5): a term appearing 3× scores ~2.2× vs 1×, not 3×.
// Multi-word phrases score ×2 — more specific than unigrams.
const BM25_K1 = 1.5;
function scoreFieldIDF(text, term, idfWeight, fieldBoost) {
  if (!text || !text.includes(term)) return 0;
  const tf   = countOccurrences(text, term);
  const tfBM = (tf * (BM25_K1 + 1)) / (tf + BM25_K1);
  return idfWeight * fieldBoost * tfBM * (term.includes(' ') ? 2 : 1);
}

// Compute smoothed IDF for each raw query term against the article corpus.
// Rare terms (appear in few articles) get higher weight → boost precision.
// Formula: log10((N+1) / (df+1)) + 1   (smoothed, never reaches 0)
function computeQueryIDF(articles, rawTerms) {
  const N = Math.max(articles.length, 1);
  const weights = {};
  for (const term of rawTerms) {
    if (articleDfCache && articleDfCache[term] !== undefined) {
      weights[term] = articleDfCache[term];
    } else {
      // Fallback: scan (used only during warm-up before dfCache is ready)
      let df = 0;
      for (const a of articles) {
        const hay = `${a.title} ${a.category} ${a.keywords} ${a.extractedKeywords}`.toLowerCase();
        if (hay.includes(term)) df++;
      }
      weights[term] = Math.log10((N + 1) / (df + 1)) + 1;
    }
  }
  return weights;
}

// Reciprocal Rank Fusion — merges multiple ranked lists.
// RRF(d) = Σ 1/(k + rank_i(d))  — standard k=60
// Used to combine the raw query pass with synonym-expanded variant passes.
function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((article, rank) => {
      const prev = scores.get(article.url) || { article, score: 0 };
      scores.set(article.url, { article, score: prev.score + 1 / (k + rank + 1) });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ article }) => article);
}

function searchArticles(articles, rawQuery) {
  const q = sanitizeQuery(rawQuery);
  if (!q) return [];

  // Split into tokens; preserve short but meaningful abbreviations
  const KEEP_SHORT = new Set(['gb','eu','uk','qr','us','fr']);
  const rawWords = q.split(/\s+/).filter(w =>
    (w.length > 2 || KEEP_SHORT.has(w)) && !STOPWORDS.has(w)
  );
  if (rawWords.length === 0) return [];

  const { terms: expanded, boostConcepts } = expandTerms(rawWords, q);

  // ── IDF weights: rare corpus terms get higher weight ─────────────────────
  const idf = computeQueryIDF(articles, rawWords);

  // ── Build weighted term list ──────────────────────────────────────────────
  // Raw query terms use their IDF weight directly.
  // Synonyms / expanded terms use 25% of their parent's IDF (RAGFlow: 0.25×).
  const rawSet = new Set(rawWords);
  const termWeights = [];
  for (const term of expanded) {
    if (rawSet.has(term)) {
      termWeights.push({ term, weight: idf[term] || 1 });
    } else {
      // Find the parent raw word whose synonym list contains this term
      let parentW = 0.5;
      for (const rw of rawWords) {
        if (SYNONYMS[rw]?.includes(term) || SYNONYMS[term]?.includes(rw)) {
          parentW = idf[rw] || 1;
          break;
        }
      }
      termWeights.push({ term, weight: parentW * 0.25 });
    }
  }

  const scored = articles.map(article => {
    const title    = article._titleLC;
    const category = article._categoryLC;
    const keywords = article.keywords;
    const extkw    = article.extractedKeywords || '';
    const content  = article.content || '';
    let score = 0;

    // ── Exact / full-phrase match on raw query ────────────────────────────
    if (title === q)            score += 400;
    else if (title.includes(q)) score += 200;
    if (category.includes(q))   score += 80;
    if (keywords.includes(q))   score += 60;
    if (extkw.includes(q))      score += 55;
    if (content.includes(q))    score += 40;

    // ── IDF-weighted field scoring ────────────────────────────────────────
    // Field-boost multipliers mirror RAGFlow's ^N weights per field.
    // Content is capped at 0.5× to reduce noise from long page bodies.
    for (const { term, weight } of termWeights) {
      score += scoreFieldIDF(title,    term, weight, FIELD_BOOSTS.title);
      score += scoreFieldIDF(category, term, weight, FIELD_BOOSTS.category);
      score += scoreFieldIDF(keywords, term, weight, FIELD_BOOSTS.keywords);
      score += scoreFieldIDF(extkw,    term, weight, FIELD_BOOSTS.extkw);
      score += scoreFieldIDF(content,  term, weight, FIELD_BOOSTS.content) * 0.5;
    }

    // ── Bigram scoring ────────────────────────────────────────────────────
    // RAGFlow: bigram_weight = max(w_left, w_right) × 0.6
    // Adjacent token pairs are stronger intent signals than isolated unigrams.
    for (let i = 0; i < rawWords.length - 1; i++) {
      const bigram   = `${rawWords[i]} ${rawWords[i + 1]}`;
      const bigramW  = Math.max(idf[rawWords[i]] || 1, idf[rawWords[i + 1]] || 1) * 0.6;
      score += scoreFieldIDF(title,    bigram, bigramW, FIELD_BOOSTS.title);
      score += scoreFieldIDF(keywords, bigram, bigramW, FIELD_BOOSTS.keywords);
      score += scoreFieldIDF(content,  bigram, bigramW, FIELD_BOOSTS.content);
    }

    // ── Concept boost: phrase match confirmed the intent ──────────────────
    for (const concept of boostConcepts) {
      if (title.includes(concept))    score += 200;
      if (category.includes(concept)) score += 80;
      if (keywords.includes(concept)) score += 60;
      if (extkw.includes(concept))    score += 55;
    }

    // ── IDF-weighted prefix match on title tokens ─────────────────────────
    // Catches stemming gaps ("install" → "installation") with IDF awareness
    const titleTokens = title.split(/[\s:,\-&()]+/);
    for (const word of rawWords) {
      const w = idf[word] || 1;
      for (const token of titleTokens) {
        if (token && token.length > 2 && (token.startsWith(word) || word.startsWith(token))) {
          score += w * 3;
        }
      }
    }

    // ── Min-should-match (RAGFlow: 0.30) ─────────────────────────────────
    // Applied to the top-10 most IDF-discriminative raw terms only.
    // If we used ALL rawWords, long conversation texts (40+ tokens from bot
    // messages) would require ~12 words to appear in a single article, making
    // it impossible for any article to pass. Capping at 10 keeps the check
    // meaningful for both 2-word manual queries and full conversation threads.
    const checkTerms = rawWords.length > 10
      ? [...rawWords].sort((a, b) => (idf[b] || 1) - (idf[a] || 1)).slice(0, 10)
      : rawWords;
    if (checkTerms.length >= 2) {
      const directHits = checkTerms.filter(w =>
        title.includes(w) || category.includes(w) ||
        keywords.includes(w) || extkw.includes(w) || content.includes(w)
      ).length;
      if (directHits / checkTerms.length < 0.30) return { ...article, score: 0 };
    }

    return { ...article, score };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Multi-query search with Reciprocal Rank Fusion.
// Runs the raw query + up to 2 synonym-expanded variants, merges with RRF.
// This catches vocabulary mismatches ("cancel" → "refund", "slow" → "throttled").
function searchArticlesRRF(articles, rawQuery) {
  const q = sanitizeQuery(rawQuery);
  if (!q) return [];

  // Pass 1: raw query
  const pass1 = searchArticles(articles, rawQuery);

  // Generate variant queries from top synonym keys that match the query
  const variantQueries = new Set();
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    if (q.includes(key) || syns.some(s => q.includes(s))) {
      // Build a variant query using the canonical key
      variantQueries.add(key);
      // And the first multi-word synonym phrase if any
      const phrase = syns.find(s => s.includes(' '));
      if (phrase) variantQueries.add(phrase);
    }
  }

  const passes = [pass1];
  let count = 0;
  for (const variant of variantQueries) {
    if (count >= 2) break; // max 2 extra passes
    if (variant !== q) {
      const results = searchArticles(articles, variant);
      if (results.length > 0) { passes.push(results); count++; }
    }
  }

  // Single pass — no need for RRF merge
  if (passes.length === 1) return pass1;

  return reciprocalRankFusion(passes);
}

// Maps Intercom partner slugs to keywords found in article titles
const PARTNER_TITLE_MAP = {
  'fram': 'fram',
  'afklm': 'air france', 'air_france_klm': 'air france', 'air-france-klm': 'air france',
  'kiwi': 'kiwi',
  'singapore': 'singapore', 'singapore_airlines': 'singapore',
  'wego': 'wego',
  'almosafer': 'almosafer',
  'turbopass': 'turbopass',
  'enuygun': 'enuygun',
  'makemytrip': 'makemytrip',
  'evaneos': 'evaneos',
  'barcelo': 'barcel',
  'omio': 'omio',
  'wifimap': 'wifimap',
  'raileurope': 'raileurope',
  'firsttrip': 'firsttrip',
  'exoticca': 'exoticca',
  'corendon': 'corendon',
  'air_astana': 'air astana', 'air-astana': 'air astana',
  'air_india': 'air india', 'air-india': 'air india',
  'transavia': 'transavia',
  'dscoop': 'dscoop',
  'axa': 'axa',
  'comptoir': 'comptoir',
  'vietnamese': 'vietnamese',
  'user_soft_launch': null, // internal — no partner article
};

// Countries where eSIM is blocked / heavily restricted
const RESTRICTED_COUNTRIES = new Set(['eg','egy','egypt','tr','tur','turkey','cn','china']);

// Chinese-market device brands — often have eSIM installation quirks
const CHINESE_BRANDS = new Set([
  'oppo','huawei','xiaomi','oneplus','realme','vivo','honor','zte','meizu','lenovo',
  'tcl','tecno','infinix','nothing',
]);

function extractContactContext(body) {
  const contact = body.contact || {};
  const attrs   = contact.custom_attributes || {};

  const esimStatus = (
    attrs.esim_status ||
    attrs.latest_sparks_esim_status ||
    attrs.latest_lanck_esim_status || ''
  ).toLowerCase();

  const partnerSlug = (attrs.initial_referrer_partner_slug || '').toLowerCase().replace(/ /g, '_');

  // Data usage: "0 bytes" or 0 means data never started
  const consumed = String(attrs.current_plan_consumed || '').toLowerCase();
  const dataNeverUsed = (consumed === '0 bytes' || consumed === '0' || consumed === '')
    && !attrs.current_plan_usage_started_at
    && !!attrs.current_plan_limit; // a plan exists

  // Destination country
  const planZone = (attrs.current_plan_zone_code || attrs.initial_gift_zone_code || '').toLowerCase();
  const isRestrictedCountry = RESTRICTED_COUNTRIES.has(planZone);

  const deviceBrand = (attrs.device_brand || '').toLowerCase();
  const isChineseDevice = CHINESE_BRANDS.has(deviceBrand);

  return {
    // Device
    isIOS:             !!contact.ios_device   || !!contact.ios_app_version,
    isAndroid:         !!contact.android_device || !!contact.android_app_version,
    deviceBrand,
    isChineseDevice,

    // eSIM
    esimStatus,
    esimCompatible:    attrs.is_device_esim_compatible,
    esimInstallCount:  attrs.esim_installation_count || 0,
    esimLastCountry:   attrs.esim_last_detected_country,   // null = never connected
    isOneClick:        attrs.esim_is_one_click_installable,

    // Data plan
    dataNeverUsed,                                          // plan exists but 0 bytes consumed
    dataExpired:       !!attrs.current_plan_expires_at && new Date(attrs.current_plan_expires_at) < new Date(),
    planZone,
    planZoneLabel:     (attrs.current_plan_zone_label || attrs.initial_gift_zone_label || '').toLowerCase(),
    isRestrictedCountry,

    // Partner & loyalty
    partnerSlug,
    partnerKeyword:    PARTNER_TITLE_MAP[partnerSlug] ?? (partnerSlug.replace(/_/g, ' ') || null),
    hasFlyingBlue:     !!(attrs.flying_blue_number),

    // eSIM identifiers
    esimIccid:         attrs.esim_iccid || null,

    // Account
    fraudSuspected:    attrs.fraud_suspected === true,
    isB2B:             attrs.is_b2b === true,
    isNewUser:         (attrs.user_value === 0 || attrs.user_value === null),
    hasReferred:       attrs.has_referred === true,
    language:          attrs.language || '',
  };
}

// Returns the single most relevant agent hint for this article + contact context combination
function getArticleHint(article, ctx) {
  if (!ctx) return null;

  const title    = article._titleLC;
  const category = article._categoryLC;

  // Check uninstalled/not-installed FIRST, then installed — avoids "uninstalled".includes("installed")
  const esimUninstalled = /uninstalled|not_installed|deleted/.test(ctx.esimStatus);
  const esimInstalled   = !esimUninstalled && /installed|enabled|active/.test(ctx.esimStatus);
  const esimDisabled    = /disabled/.test(ctx.esimStatus);
  const neverConnected  = esimInstalled && ctx.esimLastCountry === null;

  // ── Installation ──────────────────────────────────────────────────────────
  if (category.includes('install') || title.includes('install') || title.includes('qr') ||
      title.includes('setup') || title.includes('set up') || title.includes('activate') ||
      title.includes('add esim')) {
    // Key learning: if eSIM is already installed, the real issue is finding it in settings
    if (esimInstalled && ctx.esimInstallCount >= 1) {
      if (ctx.isIOS)
        return 'eSIM already installed — check Settings > Mobile Data (may show as Secondary/Travel/Business)';
      if (ctx.isAndroid)
        return 'eSIM already installed — check Settings > Network > SIM cards';
      return 'eSIM already installed — ask customer to check phone SIM settings';
    }
    if (ctx.esimCompatible === false)
      return 'Check 3.2 — device not compatible';
    if (ctx.isChineseDevice)
      return `Check 3.6 — ${ctx.deviceBrand} device (China/HK/Macao)`;
    if (ctx.esimInstallCount >= 3 && ctx.isOneClick === false)
      return 'Check 3.0 — 1-click install limit reached (3×)';
    if (ctx.esimInstallCount > 1)
      return 'Check 3.7 — eSIM previously installed on another device';
    if (!ctx.esimIccid && !esimInstalled)
      return 'Check 3.10 — no eSIM linked to account';
    if (esimUninstalled)
      return 'eSIM uninstalled — fresh install expected';
  }

  // ── Locate eSIM in settings (distinct from install problems) ──────────────
  // Guard: only fire when the article is actually about locating/seeing an eSIM —
  // prevents "Finding partner details" (Travel Partners category) from matching.
  const isAboutLocatingESIM =
    (title.includes('find') || title.includes('locat') || title.includes('see') ||
     title.includes('show') || title.includes('visible') || title.includes('appear')) &&
    (title.includes('esim') || title.includes('sim') ||
     category.includes('install') || category.includes('start using') || category.includes('connect'));
  if (isAboutLocatingESIM) {
    if (esimInstalled) {
      if (ctx.isIOS)
        return "eSIM installed — check Settings > Mobile Data (may show as 'Plus', 'TIM', 'Orange' or 'Proximus', NOT 'Kolet')";
      if (ctx.isAndroid)
        return 'eSIM installed — check Settings > Network > SIM cards (or Connections)';
    }
    if (!esimInstalled)
      return 'eSIM not yet installed — use the install button in the app';
  }

  // ── Connection / start using / APN ────────────────────────────────────────
  if (category.includes('connect') || category.includes('start using') ||
      title.includes('apn') || title.includes('connect') || title.includes('no data') ||
      title.includes('internet') || title.includes('roaming') || title.includes('signal') ||
      title.includes('sos') || title.includes('grey') || title.includes('gray')) {
    if (ctx.isRestrictedCountry)
      return `Destination: ${ctx.planZone.toUpperCase()} — government restrictions may apply`;
    if (esimDisabled)
      return 'eSIM disabled — toggle may appear greyed out; check account status';
    if (ctx.dataNeverUsed && esimInstalled) {
      if (title.includes('apn'))
        return 'eSIM installed — verify APN settings';
      return 'Check: roaming enabled + Kolet set as primary data SIM';
    }
    if (neverConnected)
      return 'Check: roaming enabled + Kolet set as primary data SIM';
    if (ctx.dataExpired)
      return 'Data plan expired — renewal needed before reconnecting';
    if (ctx.isAndroid)
      return 'Android device — check roaming + Kolet as primary data SIM';
  }

  // ── Refund / billing / invoice ────────────────────────────────────────────
  if (category.includes('refund') || category.includes('billing') ||
      title.includes('refund') || title.includes('reimburse') ||
      title.includes('invoice') || title.includes('payment') || title.includes('cashback')) {
    if (ctx.dataNeverUsed && esimInstalled)
      return 'Data never used — full refund likely applicable';
    if (ctx.dataNeverUsed)
      return 'Data never used';
    if (ctx.dataExpired)
      return 'Plan expired — check refund eligibility';
    if (ctx.isNewUser)
      return 'First-time customer';
  }

  // ── Account / login / verification ───────────────────────────────────────
  if (category.includes('account') || category.includes('login') ||
      title.includes('login') || title.includes('sign in') || title.includes('otp') ||
      title.includes('password') || title.includes('delete account')) {
    if (ctx.fraudSuspected)
      return '⚠️ Fraud flag active on this account';
    if (ctx.isB2B)
      return 'B2B account';
    if (ctx.isNewUser)
      return 'New / first-time account';
  }

  // ── Fraud / blocked / banned ──────────────────────────────────────────────
  if (category.includes('fraud') || title.includes('fraud') ||
      title.includes('ban') || title.includes('suspended') || title.includes('disposable')) {
    if (ctx.fraudSuspected)
      return '⚠️ Fraud flag is active on this account';
    if (ctx.isB2B)
      return 'B2B account';
  }

  // ── Transfer / reassign / new device ─────────────────────────────────────
  if (title.includes('reassign') || title.includes('transfer') || title.includes('move') ||
      title.includes('new device') || title.includes('new phone') || title.includes('change device') ||
      title.includes('migrate') || category.includes('transfer')) {
    if (ctx.esimInstallCount > 1)
      return `eSIM installed ${ctx.esimInstallCount}× — previously used on another device`;
    if (ctx.esimInstallCount === 1)
      return 'eSIM installed once — on current device';
    if (ctx.isChineseDevice)
      return `${ctx.deviceBrand} — verify eSIM slot availability on new device`;
  }

  // ── Data plan / extend / renew ────────────────────────────────────────────
  if (category.includes('data') || category.includes('plan') ||
      title.includes('extend') || title.includes('renew') || title.includes('top up') ||
      title.includes(' gb') || title.includes('bundle') || title.includes('usage')) {
    if (ctx.dataExpired)
      return 'Current plan expired — renewal needed';
    if (ctx.dataNeverUsed)
      return 'Current plan active but never used';
  }

  // ── Restricted country / government block ────────────────────────────────
  if (title.includes('egyptian') || title.includes('turkish') || title.includes('china') ||
      title.includes('government') || title.includes('constraint') || title.includes('vpn')) {
    if (ctx.isRestrictedCountry)
      return `Destination: ${ctx.planZone.toUpperCase()} — government restrictions likely apply`;
  }

  // ── Partner articles ──────────────────────────────────────────────────────
  if (category.includes('travel partner') || category.includes('partner') ||
      title.includes('partner')) {
    if (ctx.partnerSlug && ctx.partnerSlug !== 'user_soft_launch' && ctx.partnerSlug !== '')
      return `Acquired via: ${ctx.partnerSlug.replace(/_/g, ' ')}`;
  }

  // ── Flying Blue / miles / loyalty ─────────────────────────────────────────
  if (title.includes('flying blue') || title.includes('air france') ||
      title.includes('miles') || title.includes('afklm') || title.includes('loyalty') ||
      category.includes('miles')) {
    if (ctx.hasFlyingBlue)
      return 'Flying Blue member — loyalty account is linked';
    if (ctx.partnerSlug && ctx.partnerSlug.includes('afklm'))
      return 'AF/KLM partner acquisition';
  }

  // ── Referral / voucher / promo validity ──────────────────────────────────
  // Key learning: voucher VALIDITY ("when does it start / countdown") ≠ fraud
  if (title.includes('referral') || title.includes('voucher') || title.includes('promo') ||
      title.includes('discount') || title.includes('invite') || title.includes('validity') ||
      title.includes('valid') || category.includes('referral')) {
    if (ctx.partnerSlug && ctx.partnerSlug.includes('axa'))
      return 'AXA insurance voucher — countdown starts on first activation';
    if (ctx.hasReferred)
      return 'Customer has already referred friends';
    if (ctx.isNewUser)
      return 'New user — may have redeemed a referral';
  }

  // ── Koins / convert unused data ──────────────────────────────────────────
  if (title.includes('koin') || title.includes('convert') || title.includes('unused') ||
      title.includes('remaining') || category.includes('koin') || category.includes('convert')) {
    if (ctx.dataExpired)
      return 'Plan expired — conversion window may have closed';
    if (ctx.dataNeverUsed)
      return 'Data never used — full conversion to Koins may be possible';
  }

  // ── B2B ───────────────────────────────────────────────────────────────────
  if (title.includes('b2b') || title.includes('business') || title.includes('enterprise') ||
      category.includes('b2b')) {
    if (ctx.isB2B)
      return 'B2B account confirmed';
  }

  return null;
}

function applyContextBoosts(allArticles, scored, ctx, convCtx) {
  if (!ctx && !convCtx) return scored.slice(0, 5);

  const esimUninstalled = ctx ? /uninstalled|not_installed|deleted/.test(ctx.esimStatus) : false;
  const esimInstalled   = ctx ? !esimUninstalled && /installed|enabled|active/.test(ctx.esimStatus) : false;
  const esimDisabled    = ctx ? /disabled/.test(ctx.esimStatus) : false;
  const neverConnected  = esimInstalled && ctx?.esimLastCountry === null;

  // Force-inject articles for strong context signals even when text score = 0
  const scoredUrls = new Set(scored.map(a => a.url));
  const injected   = [];

  function inject(articles, filterFn, baseScore) {
    articles.filter(a => filterFn(a) && !scoredUrls.has(a.url))
      .forEach(a => { injected.push({ ...a, score: baseScore }); scoredUrls.add(a.url); });
  }

  // ── Step 1: hard contact-attribute signals ────────────────────────────────
  if (ctx?.partnerKeyword) {
    inject(allArticles, a => a._titleLC.includes(ctx?.partnerKeyword), 250);
  }
  if (ctx?.fraudSuspected) {
    inject(allArticles, a => a._categoryLC.includes('fraud'), 200);
  }
  if (ctx?.esimCompatible === false) {
    inject(allArticles, a => {
      const t = a._titleLC;
      return t.includes('adapter') || t.includes('compatible');
    }, 220);
  }
  if (ctx?.isRestrictedCountry) {
    inject(allArticles, a => {
      const t = a._titleLC;
      return t.includes('egyptian') || t.includes('turkish') ||
             (t.includes('blocked') && t.includes('government')) ||
             t.includes('constraint');
    }, 230);
  }
  if (ctx?.hasFlyingBlue) {
    inject(allArticles, a => {
      const t = a._titleLC;
      return t.includes('air france') || t.includes('flying blue');
    }, 210);
  }
  if (ctx?.isB2B) {
    inject(allArticles, a => {
      const t = a._titleLC;
      return t.includes('b2b') || t.includes('business');
    }, 200);
  }

  // ── Step 2: intent detection (regex + Intercom tags + inbox name) ─────────
  // signalText uses fullText (all messages incl. bot) for intent detection so
  // the AI agent's reply title (e.g. "PIN/PUK Code") is also a signal.
  const tagText    = (convCtx?.tags  || []).join(' ');
  const inboxName  = (convCtx?.inboxName || '').toLowerCase();
  const signalText = [convCtx?.fullText || convCtx?.text || '', inboxName, tagText].join(' ');
  const intents    = detectIntents(signalText);

  // Intercom workflow tags are high-confidence signals — apply TAG_INTENT_MAP
  TAG_INTENT_MAP.forEach(([re, intent]) => {
    if (re.test(tagText) || re.test(inboxName)) intents.add(intent);
  });

  // ── Step 3: inject articles for each detected intent ─────────────────────
  for (const [intent, filterFn, score] of INTENT_INJECT_MAP) {
    if (intents.has(intent)) inject(allArticles, filterFn, score);
  }

  const combined = [...scored, ...injected];

  // ── Step 4: eSIM-state fallback (never return empty for eSIM-related convos) ──
  // Fires when: no results yet AND (we have an eSIM status OR we have conversation text).
  // Leads (no custom_attributes) have empty esimStatus but still have conversation text.
  if (combined.length === 0 && (ctx?.esimStatus || convCtx?.text)) {
    if (esimInstalled) {
      inject(allArticles, a => {
        const cat = a._categoryLC;
        const t   = a._titleLC;
        return cat.includes('connect') || cat.includes('start using') ||
               t.includes('find') || t.includes('locat') || t.includes('constraint');
      }, 120);
    } else if (esimUninstalled || !ctx?.esimIccid) {
      inject(allArticles, a => a._categoryLC.includes('install'), 120);
    }
    combined.push(...injected.filter(a => !scored.some(s => s.url === a.url)));
  }

  // Pre-compute context fingerprint once (used in Step 5 for feedback multiplier)
  // Pass the already-computed intents Set to avoid re-running detectIntents
  const ctxFingerprint = buildContextFingerprint(
    ctx,
    convCtx ? { inbox_name: convCtx.inboxName, tags: convCtx.tags } : {},
    convCtx?.text || '',
    intents
  );

  return combined.map(article => {
    let bonus = 0;
    const title    = article._titleLC;
    const category = article._categoryLC;

    // --- eSIM status signals ---
    if (esimUninstalled) {
      if (category.includes('install'))                                bonus += 150;
      if (category.includes('connect') || category.includes('start')) bonus -=  20;
    }
    if (esimInstalled) {
      if (category.includes('connect') || category.includes('start')) bonus +=  80;
      // Key learning: eSIM already installed → locate/connectivity, NOT install guides
      if (category.includes('install') &&
          !title.includes('reassign') && !title.includes('transfer') &&
          !title.includes('move'))                                      bonus -=  60;
      if (category.includes('connect') || category.includes('start using'))  bonus += 100;
    }
    if (esimDisabled) {
      if (category.includes('connect'))                                bonus +=  60;
      if (category.includes('account'))                                bonus +=  40;
    }

    // --- Data never used (plan exists but 0 bytes consumed) ---
    if (ctx?.dataNeverUsed && esimInstalled) {
      if (category.includes('start using'))                            bonus += 120;
      if (title.includes('apn'))                                       bonus += 100;
      if (title.includes('activate') || title.includes('connect'))     bonus +=  80;
      if (category.includes('connect'))                                bonus +=  60;
    }

    // --- eSIM installed but never detected by network ---
    if (neverConnected) {
      if (category.includes('connect'))                                bonus +=  70;
      if (title.includes('apn'))                                       bonus +=  60;
    }

    // --- Multiple installs → reassignment/transfer articles ---
    if (ctx?.esimInstallCount > 1) {
      if (title.includes('reassign') || title.includes('move') || title.includes('transfer')) bonus += 80;
    }

    // --- Data expired ---
    if (ctx?.dataExpired) {
      if (title.includes('extend') || title.includes('renew'))         bonus += 100;
      if (category.includes('money'))                                  bonus +=  40;
    }

    // --- Restricted country ---
    if (ctx?.isRestrictedCountry) {
      if (title.includes('egyptian') || title.includes('turkish') ||
          (title.includes('blocked') && title.includes('government'))) bonus += 230;
      if (title.includes('constraint'))                                bonus += 150;
    }

    // --- Partner ---
    if (ctx?.partnerKeyword) {
      if (title.includes(ctx?.partnerKeyword))                          bonus += 250;
      else if (category.includes('travel partner'))                    bonus +=  40;
    }

    // --- Flying Blue ---
    if (ctx?.hasFlyingBlue) {
      if (title.includes('air france') || title.includes('flying blue') ||
          title.includes('afklm'))                                     bonus += 200;
      if (title.includes('miles') || title.includes('points'))        bonus +=  80;
    }

    // --- Fraud ---
    if (ctx?.fraudSuspected) {
      if (category.includes('fraud'))                                  bonus += 200;
    }

    // --- B2B ---
    if (ctx?.isB2B) {
      if (title.includes('b2b') || title.includes('business'))        bonus += 180;
    }

    // --- Device specifics ---
    if (ctx?.isAndroid) {
      if (title.includes('pixel') || title.includes('android'))       bonus +=  60;
    }
    if (ctx?.isIOS) {
      if (title.includes('pixel'))                                     bonus -=  40;
    }

    const baseScore = Math.max(0, article.score + bonus);

    // ── Step 5: context-aware feedback multiplier ─────────────────────────────
    // Context-specific votes take priority (if ≥ MIN_CTX_VOTES).
    // Falls back to global votes, then 1.0 (no adjustment).
    const fb   = articleFeedbackScores[article.title];
    let   mult = 1.0;
    if (fb) {
      const ctxVotes = fb.ctx?.[ctxFingerprint];
      const votes    = (ctxVotes && ctxVotes.ups + ctxVotes.downs >= FEEDBACK_MIN_CTX_VOTES)
        ? ctxVotes   // enough context-specific data → use it
        : fb.global; // fall back to global signal
      mult = feedbackSentimentMultiplier(votes);
    }

    return { ...article, score: baseScore * mult };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// Extract conversation text + structural signals (inbox, tags, topic).
//
// Returns TWO text fields so each layer of the engine uses the right signal:
//   text     — customer messages only (user/lead authors). Used for the search
//              query so bot workflow triggers and AI replies don't pollute it.
//   fullText — every message including bot/admin. Used for intent detection so
//              we also catch signals from the AI agent's reply titles.
function extractConversationContext(body) {
  const conv = body.conversation || {};

  // ── Customer-only text (search query) ──────────────────────────────────
  // Source: include if the author is not a bot (workflow triggers like
  // "🤖 Talk to Kokobot" come from the user's action but contain bot text;
  // we include the source subject (email subject) but skip pure bot bodies).
  const userParts = [];
  if (conv.source?.subject) userParts.push(conv.source.subject);
  if (conv.source?.body && conv.source?.author?.type !== 'bot') {
    userParts.push(conv.source.body);
  }

  // Conversation parts: only messages authored by the customer
  const CUSTOMER_PART_TYPES = new Set(['comment', 'open']); // 'open' = reopen
  for (const part of (conv.conversation_parts?.conversation_parts || [])) {
    const atype = part.author?.type;
    if (part.body && (atype === 'user' || atype === 'lead') &&
        CUSTOMER_PART_TYPES.has(part.part_type)) {
      userParts.push(part.body);
    }
  }
  const text = userParts
    .filter(Boolean)
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ── Full thread text (intent detection) ────────────────────────────────
  // Includes bot replies — useful because the AI agent's reply title often
  // names the exact article category (e.g. "PIN/PUK Code").
  const allParts = [
    conv.source?.subject,
    conv.source?.body,
    conv.first_contact_reply?.body,
  ];
  for (const part of (conv.conversation_parts?.conversation_parts || [])) {
    if (part.body) allParts.push(part.body);
  }
  const fullText = allParts
    .filter(Boolean)
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Team inbox name — strongest single signal (e.g. "Installation Issues")
  const inboxName = (
    conv.assignee?.name ||
    conv.team_assignee?.name ||
    ''
  ).toLowerCase().trim();

  // Conversation tags (e.g. ["refund", "android"])
  const tags = (conv.tags?.tags || [])
    .map(t => (t.name || '').toLowerCase())
    .filter(Boolean);

  // Conversation topic if set
  const topic = (conv.conversation_topic?.name || '').toLowerCase().trim();

  return { text, fullText, inboxName, tags, topic };
}

// Build augmented search query: thread text + inbox name + topic (no tags)
function buildConvSearchQuery(convCtx) {
  return [convCtx.text, convCtx.inboxName, convCtx.topic]
    .filter(Boolean)
    .join(' ');
}

// One-liner shown to the agent ("Based on: Installation Issues")
function buildConvContextLabel(convCtx) {
  if (!convCtx) return null;
  const parts = [];
  if (convCtx.inboxName) parts.push(convCtx.inboxName);
  if (convCtx.topic) parts.push(convCtx.topic);
  return parts.length ? `Based on: ${parts.join(' · ')}` : null;
}

// Emoji per article category / title keyword
const CATEGORY_EMOJI_MAP = [
  [['install', 'activation', 'activate', 'qr', 'set up', 'add esim'],   '📲'],
  [['connect', 'connection', 'signal', 'apn', 'internet', 'roaming',
    'no data', 'start using'],                                            '📡'],
  [['refund', 'reimburse', 'cashback', 'billing', 'invoice', 'payment',
    'money', 'wallet', 'koin'],                                           '💰'],
  [['account', 'login', 'sign in', 'otp', 'password', 'delete account'], '🔑'],
  [['fraud', 'fraudster', 'ban', 'suspend', 'blocked', 'disposable'],   '🚨'],
  [['transfer', 'reassign', 'move esim', 'new device', 'new phone',
    'change device', 'migrate'],                                          '🔄'],
  [['extend', 'renew', 'top up', 'bundle', 'data plan', 'gb', 'usage'],  '📦'],
  [['flying blue', 'air france', 'afklm', 'miles', 'loyalty', 'points'], '✈️'],
  [['partner', 'travel partner', 'kiwi', 'singapore', 'transavia'],      '🤝'],
  [['referral', 'voucher', 'promo', 'discount', 'invite', 'gift'],       '🎁'],
  [['b2b', 'business', 'enterprise'],                                    '🏢'],
  [['egypt', 'turkey', 'china', 'government', 'constraint', 'vpn',
    'restricted'],                                                        '🌍'],
  [['compatible', 'compatibility', 'adapter', 'device'],                 '📱'],
  [['voip', 'calling', 'call worldwide', 'calls tab', 'phone number'],   '📞'],
  [['app', 'crash', 'bug', 'update'],                                    '🐛'],
];

function getArticleEmoji(article) {
  const haystack = (article.category + ' ' + article.title).toLowerCase();
  for (const [keywords, emoji] of CATEGORY_EMOJI_MAP) {
    if (keywords.some(k => haystack.includes(k))) return emoji;
  }
  return '📄';
}

// --- Canvas builders ---

// Shared article list renderer used by both suggestions and results canvases.
// withEmoji = true  → prepend category emoji (suggestions view).
// ratedMap         → { [index]: 'up'|'down' } — shows confirmation instead of buttons.
// idPrefix         → unique prefix per section to avoid duplicate component IDs
function renderArticleComponents(articles, ctx, withEmoji = false, ratedMap = {}, idPrefix = 'open') {
  const components = [];
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const hint    = getArticleHint(article, ctx);
    components.push({ type: 'divider' });
    if (article.category) {
      components.push({ type: 'text', text: article.category, style: 'muted' });
    }
    components.push({
      type:   'button',
      id:     `${idPrefix}_${i}`,
      label:  withEmoji ? `${getArticleEmoji(article)} ${article.title}` : article.title,
      style:  'link',
      action: { type: 'url', url: article.url },
    });
    if (hint) {
      components.push({ type: 'text', text: `⚡ ${hint}`, style: 'muted' });
    }
    // Per-article feedback — only on suggestions view (withEmoji === true)
    if (withEmoji) {
      if (ratedMap[i]) {
        components.push({
          type:  'text',
          text:  ratedMap[i] === 'up' ? '👍 Marked helpful' : '👎 Marked not helpful',
          style: 'muted',
        });
      } else {
        components.push({
          type: 'button', id: `feedback_up_${i}`,
          label: '👍', style: 'secondary',
          action: { type: 'submit' },
        });
        components.push({
          type: 'button', id: `feedback_down_${i}`,
          label: '👎', style: 'secondary',
          action: { type: 'submit' },
        });
      }
    }
  }
  return components;
}

function searchInputComponents() {
  return [
    {
      type: "input",
      id: "search_query",
      label: "Search KokoBrain",
      placeholder: "refund, no connection, eSIM...",
      action: { type: "submit" }
    },
    {
      type: "button",
      id: "search_btn",
      label: "Search",
      style: "primary",
      action: { type: "submit" }
    }
  ];
}

// ratedMap:     { [articleIndex]: 'up'|'down' } — per-article feedback state.
// searchSection: { query, results } — when present, appended below suggestions.
//                Suggestions are ALWAYS visible; search results are additive.
function buildSuggestionsCanvas(articles, convCtx, ctx, ratedMap = {}, searchSection = null) {
  const contextLabel = buildConvContextLabel(convCtx);

  const components = [
    ...searchInputComponents(),
    { type: 'divider' },
    { type: 'text', text: 'Suggested articles', style: 'header' },
  ];
  if (contextLabel) {
    components.push({ type: 'text', text: contextLabel, style: 'muted' });
  }
  components.push(...renderArticleComponents(articles, ctx, true, ratedMap));

  // Append search results below — suggestions never disappear
  if (searchSection) {
    components.push({ type: 'divider' });
    components.push({ type: 'text', text: `Results for "${searchSection.query}"`, style: 'header' });
    components.push({
      type: 'button', id: 'back_btn',
      label: '✕ Clear results',
      style: 'secondary',
      action: { type: 'submit' },
    });
    if (searchSection.results.length === 0) {
      components.push({ type: 'text', text: 'No articles found.', style: 'muted' });
    } else {
      // Use 'result' prefix to avoid ID collision with suggestion 'open_N' buttons
      components.push(...renderArticleComponents(searchSection.results, ctx, false, {}, 'result'));
    }
  }

  return {
    canvas: {
      stored_data: {
        conv_query:        convCtx ? buildConvSearchQuery(convCtx).slice(0, 400) : '',
        ctx:               ctx || null,
        inbox_name:        convCtx?.inboxName || '',
        tags:              convCtx?.tags      || [],
        feedback_articles: articles.slice(0, 7).map(a => a.title),
        rated:             ratedMap,
      },
      content: { components },
    },
  };
}

const searchOnlyCanvas = {
  canvas: {
    stored_data: {},
    content: {
      components: [
        ...searchInputComponents(),
        { type: "divider" },
        { type: "text", text: "Type a keyword above to find articles", style: "muted" },
      ]
    }
  }
};

// searchRated: { [idx]: 'up'|'down' } — per-result feedback state (for re-render after vote)
function buildResultsCanvas(headerText, articles, convQuery, ctx, storedConvCtxMeta = {}, searchQuery = '', searchRated = {}) {
  const hasSuggestions = Boolean(convQuery) || Boolean(ctx);
  const components = [
    ...searchInputComponents(),
    {
      type:   'button',
      id:     'back_btn',
      label:  hasSuggestions ? '← Back to suggestions' : '← Clear results',
      style:  'secondary',
      action: { type: 'submit' },
    },
    { type: 'divider' },
    { type: 'text', text: headerText, style: 'header' },
  ];

  if (articles.length === 0) {
    components.push({ type: 'text', text: 'No articles found.', style: 'muted' });
  } else {
    // Render each result with per-article 👍/👎 feedback buttons
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const hint    = getArticleHint(article, ctx);
      components.push({ type: 'divider' });
      components.push({
        type: 'button', id: `result_${i}`,
        label: article.title, style: 'link',
        action: { type: 'url', url: article.url },
      });
      if (hint) components.push({ type: 'text', text: `⚡ ${hint}`, style: 'muted' });
      if (searchRated[i]) {
        components.push({
          type: 'text',
          text: searchRated[i] === 'up' ? '👍 Marked helpful' : '👎 Marked not helpful',
          style: 'muted',
        });
      } else {
        components.push({ type: 'button', id: `search_up_${i}`,   label: '👍', style: 'secondary', action: { type: 'submit' } });
        components.push({ type: 'button', id: `search_down_${i}`, label: '👎', style: 'secondary', action: { type: 'submit' } });
      }
    }
  }

  return {
    canvas: {
      stored_data: {
        conv_query:      convQuery || '',
        ctx:             ctx || null,
        inbox_name:      storedConvCtxMeta.inbox_name || '',
        tags:            storedConvCtxMeta.tags        || [],
        search_query:    searchQuery,
        search_articles: articles.slice(0, 5).map(a => a.title),
        search_rated:    searchRated,
      },
      content: { components },
    },
  };
}

function buildErrorCanvas(msg) {
  return {
    canvas: {
      stored_data: {},
      content: {
        components: [
          { type: "text", text: msg || "Something went wrong. Try again.", style: "muted" },
          ...searchInputComponents()
        ]
      }
    }
  };
}

// --- Routes ---

app.get('/intercom/initialize', (req, res) => res.json(searchOnlyCanvas));

app.post('/intercom/initialize', verifyIntercomRequest, async (req, res) => {
  try {
    lastInit = { convId: req.body.conversation?.id, ts: new Date().toISOString(), inboxName: req.body.conversation?.assignee?.name };

    const convId  = String(req.body.conversation?.id || '');
    const convCtx = extractConversationContext(req.body);
    const ctx     = extractContactContext(req.body);

    console.log('INIT conv:', convId, '| inbox:', convCtx.inboxName, '| topic:', convCtx.topic);
    console.log('INIT text (first 200):', convCtx.text.slice(0, 200));
    console.log('INIT esim:', ctx.esimStatus, '| partner:', ctx.partnerSlug);

    const augmentedQuery = buildConvSearchQuery(convCtx);

    if (augmentedQuery) {
      const articles    = await getArticles();
      const rawResults  = searchArticles(articles, augmentedQuery);
      const suggestions = applyContextBoosts(articles, rawResults, ctx, convCtx);
      if (suggestions.length > 0) {
        console.log(`Suggested ${suggestions.length} articles for conv=${convId} inbox="${convCtx.inboxName}"`);
        // Cache by conversation ID — submit handler uses this as primary source
        cacheConvSuggestions(convId, suggestions.map(a => a.title),
          augmentedQuery.slice(0, 400), ctx,
          { inbox_name: convCtx.inboxName, tags: convCtx.tags });
        return res.json(buildSuggestionsCanvas(suggestions, convCtx, ctx));
      }
    }

    return res.json(searchOnlyCanvas);
  } catch (err) {
    lastError = { route: 'init', message: err.message, stack: err.stack, time: new Date().toISOString() };
    console.error('INIT ERROR:', err.message, err.stack);
    return res.json(searchOnlyCanvas);
  }
});

app.post('/intercom/submit', verifyIntercomRequest, async (req, res) => {
  try {
    lastSubmit = { componentId: req.body.component_id, convId: req.body.conversation?.id, ts: new Date().toISOString() };
    console.log('SUBMIT component_id:', req.body.component_id);

    const componentId = String(req.body.component_id || '').slice(0, 100);
    const convId      = String(req.body.conversation?.id || '');

    // Intercom Canvas Kit sends stored_data under `canvas.stored_data`.
    // We also check `canvas_data.stored_data` as a fallback for older payloads.
    // Primary source of truth is the server-side convSuggestionsCache.
    const storedData  = req.body.canvas?.stored_data
                     || req.body.canvas_data?.stored_data
                     || {};
    console.log('SUBMIT conv:', convId, '| component:', componentId,
                '| storedData keys:', Object.keys(storedData).join(','));

    // Server cache is source of truth. storedData fallbacks sanitized to prevent injection.
    const cached = getCachedConvSuggestions(convId);
    if (!cached) console.warn(`SUBMIT cache miss conv=${convId}`);

    // feedbackTitles: clamp to 7 entries, each a string max 200 chars
    const rawFeedbackTitles = cached?.titles || storedData.feedback_articles || [];
    const feedbackTitles = (Array.isArray(rawFeedbackTitles) ? rawFeedbackTitles : [])
      .slice(0, 7).map(t => String(t).slice(0, 200));

    // resolvedCtx: never trust storedData.ctx — only use server-side cache
    const resolvedCtx = cached?.ctx || null;

    const resolvedQuery = String(cached?.convQuery || storedData.conv_query || '').slice(0, 400);
    const resolvedMeta  = cached?.meta || {
      inbox_name: String(storedData.inbox_name || '').slice(0, 100),
      tags: (Array.isArray(storedData.tags) ? storedData.tags : []).slice(0, 20).map(t => String(t).slice(0, 50)),
    };
    const storedRated = storedData.rated || {};

    console.log('SUBMIT sugg titles:', feedbackTitles.length, '| cached:', Boolean(cached));

    // URL buttons open Notion directly — no state change needed
    if (componentId.startsWith('open_') || componentId.startsWith('result_')) {
      return res.status(200).end();
    }

    // Restore the exact suggestion articles shown (by title lookup from KB cache).
    // This works even when stored_data is empty — feedbackTitles comes from
    // the server-side conversation cache set during /initialize.
    const allArticles = await getArticles();
    const titleMap    = articleByTitle || new Map(allArticles.map(a => [a.title, a]));
    const storedSuggs = feedbackTitles.map(t => titleMap.get(t)).filter(Boolean);

    const storedConvCtx = {
      text:      resolvedQuery,
      fullText:  resolvedQuery,
      inboxName: resolvedMeta.inbox_name,
      tags:      resolvedMeta.tags,
      topic:     '',
    };

    // ── Per-article feedback (feedback_up_N / feedback_down_N) ───────────────
    const feedbackMatch = componentId.match(/^feedback_(up|down)_(\d+)$/);
    if (feedbackMatch) {
      const rating     = feedbackMatch[1];
      const articleIdx = parseInt(feedbackMatch[2], 10);

      if (articleIdx >= feedbackTitles.length) {
        return res.json(storedSuggs.length > 0
          ? buildSuggestionsCanvas(storedSuggs, storedConvCtx, resolvedCtx, storedRated)
          : searchOnlyCanvas);
      }
      const articleTitle = feedbackTitles[articleIdx];
      if (!articleTitle || !titleMap.has(articleTitle)) {
        console.warn(`Feedback rejected: unknown article "${articleTitle}"`);
        return res.json(storedSuggs.length > 0
          ? buildSuggestionsCanvas(storedSuggs, storedConvCtx, resolvedCtx, storedRated)
          : searchOnlyCanvas);
      }

      recordFeedback(rating, articleTitle, resolvedQuery, resolvedCtx, resolvedMeta, feedbackTitles);

      let displaySuggs = storedSuggs;
      let newRatedMap  = { ...storedRated };

      if (rating === 'down') {
        // 👎 — remove the article from view immediately
        displaySuggs = storedSuggs.filter((_, i) => i !== articleIdx);

        // Remap ratedMap indices: articles after the removed one shift down by 1
        newRatedMap = {};
        for (const [idx, r] of Object.entries(storedRated)) {
          const n = parseInt(idx, 10);
          if      (n < articleIdx) newRatedMap[n]     = r;
          else if (n > articleIdx) newRatedMap[n - 1] = r;
          // n === articleIdx → removed, skip
        }

        // Keep server cache in sync so the article doesn't reappear on next action
        if (cached) cached.titles = cached.titles.filter(t => t !== articleTitle);

      } else {
        // 👍 — keep article, replace buttons with confirmation text
        newRatedMap[articleIdx] = 'up';
      }

      if (displaySuggs.length > 0) {
        return res.json(buildSuggestionsCanvas(displaySuggs, storedConvCtx, resolvedCtx, newRatedMap));
      }
      return res.json(searchOnlyCanvas);
    }

    // ── Search result feedback (search_up_N / search_down_N) ─────────────────
    const searchFeedbackMatch = componentId.match(/^search_(up|down)_(\d+)$/);
    if (searchFeedbackMatch) {
      const rating     = searchFeedbackMatch[1];
      const articleIdx = parseInt(searchFeedbackMatch[2], 10);

      // Server cache is primary — Intercom does NOT reliably send stored_data on clicks
      const cachedSearch = getCachedConvSearch(convId);
      const searchTitles = cachedSearch?.articleTitles
                        || (Array.isArray(storedData.search_articles) ? storedData.search_articles : []);
      const searchQ      = cachedSearch?.query || String(storedData.search_query || '').slice(0, 300);
      const prevRated    = cachedSearch?.rated  || storedData.search_rated || {};
      const articleTitle = searchTitles[articleIdx];

      if (articleTitle && titleMap.has(articleTitle)) {
        recordFeedback(rating, articleTitle, searchQ, resolvedCtx, resolvedMeta, searchTitles);
      } else {
        console.warn(`Search feedback rejected: unknown article at index ${articleIdx}`);
      }

      // Persist rated state in server cache for subsequent votes
      const newRated = { ...prevRated, [articleIdx]: rating };
      if (cachedSearch) cachedSearch.rated = newRated;

      const resultArticles = searchTitles.map(t => titleMap.get(t)).filter(Boolean);
      return res.json(buildResultsCanvas(
        `Results for "${searchQ}"`, resultArticles,
        resolvedQuery || null, resolvedCtx, resolvedMeta,
        searchQ, newRated
      ));
    }

    // ── Clear search results (back_btn) ──────────────────────────────────────
    // Suggestions never disappear — back_btn just hides the search results section.
    if (componentId === 'back_btn') {
      if (storedSuggs.length > 0) {
        return res.json(buildSuggestionsCanvas(storedSuggs, storedConvCtx, resolvedCtx, storedRated));
      }
      return res.json(searchOnlyCanvas);
    }

    // ── Search ────────────────────────────────────────────────────────────────
    const rawQuery = String(req.body.input_values?.search_query || '').slice(0, 300);
    const query    = sanitizeQuery(rawQuery);
    console.log(`Search: "${rawQuery}" -> "${query}"`);

    if (!query) {
      // Empty/cleared search — show suggestions without search results section
      if (storedSuggs.length > 0) {
        return res.json(buildSuggestionsCanvas(storedSuggs, storedConvCtx, resolvedCtx, storedRated));
      }
      return res.json(searchOnlyCanvas);
    }

    const searchResults = searchArticles(allArticles, query).slice(0, 5);
    console.log(`Found ${searchResults.length} for "${query}"`);

    // Cache search state server-side — Intercom doesn't reliably return stored_data
    // on button clicks, so feedback votes must be resolved from this cache.
    cacheConvSearch(convId, query, searchResults.map(a => a.title));

    // Always return a clean results-only canvas — the combined canvas (suggestions + results)
    // exceeded Canvas Kit's component limit (~20-30) causing silent render failure.
    // The ← Back button restores suggestions from the server-side cache.
    return res.json(buildResultsCanvas(`Results for "${query}"`, searchResults, resolvedQuery || null, resolvedCtx, resolvedMeta, query));

  } catch (err) {
    lastError = { route: 'submit', message: err.message, stack: err.stack, time: new Date().toISOString() };
    console.error('SUBMIT ERROR:', err.message, err.stack);
    return res.json(buildErrorCanvas());
  }
});

// Global Express error handler — last resort, returns valid Canvas response
app.use((err, req, res, next) => {
  console.error('EXPRESS ERROR:', err.message, err.stack);
  res.status(200).json(searchOnlyCanvas);
});

// Debug endpoints — protected by DEBUG_TOKEN env var
app.get('/debug/training', requireDebugToken, (req, res) => {
  const articles = Object.entries(articleFeedbackScores).map(([title, s]) => {
    const globalMult = +feedbackSentimentMultiplier(s.global).toFixed(3);
    const contexts   = Object.entries(s.ctx || {}).map(([fp, v]) => ({
      fingerprint: fp,
      ups:         v.ups,
      downs:       v.downs,
      multiplier:  +feedbackSentimentMultiplier(v).toFixed(3),
    })).sort((a, b) => b.ups + b.downs - (a.ups + a.downs));
    return {
      title,
      global:   { ups: s.global.ups, downs: s.global.downs, multiplier: globalMult },
      contexts,
    };
  }).sort((a, b) => (b.global.ups + b.global.downs) - (a.global.ups + a.global.downs));

  res.json({
    constants: { FEEDBACK_SMOOTHING, FEEDBACK_MAX_EFFECT, FEEDBACK_MIN_MULT, FEEDBACK_MIN_CTX_VOTES },
    note: 'Context-specific multiplier overrides global when ≥ MIN_CTX_VOTES votes exist for the same fingerprint.',
    articles,
  });
});

app.get('/debug/conv-cache',  requireDebugToken, (req, res) => {
  const entries = [];
  for (const [id, v] of convSuggestionsCache) entries.push({ id, titles: v.titles, ts: v.ts });
  res.json({ size: convSuggestionsCache.size, entries: entries.slice(-50).reverse() });
});
app.get('/debug/last-init',   requireDebugToken, (req, res) => res.json(lastInit));
app.get('/debug/last-error',  requireDebugToken, (req, res) => res.json(lastError));
app.get('/debug/last-submit', requireDebugToken, (req, res) => res.json(lastSubmit));
app.get('/debug/search', requireDebugToken, async (req, res) => {
  const q = String(req.query.q || '').slice(0, 300);
  const articles = await getArticles();
  const results = searchArticles(articles, q);
  res.json({ query: q, sanitized: sanitizeQuery(q), count: results.length, results });
});
app.get('/debug/kb', requireDebugToken, async (req, res) => {
  // Inspect the knowledge base built per article
  const articles = await getArticles();
  const enriched = articles.filter(a => a.extractedKeywords);
  res.json({
    total: articles.length,
    enriched: enriched.length,
    articles: articles.map(a => ({
      title: a.title,
      category: a.category,
      manualKeywords: a.keywords,
      extractedKeywords: a.extractedKeywords,
      contentLength: a.content.length,
    })),
  });
});
app.get('/debug/feedback', requireDebugToken, (req, res) => {
  const ups   = feedbackLog.filter(f => f.rating === 'up').length;
  const downs = feedbackLog.filter(f => f.rating === 'down').length;
  const total = feedbackLog.length;

  // Per-article stats: how many times each article was rated 👍 or 👎 directly
  const articleStats = {};
  for (const entry of feedbackLog) {
    const t = entry.rated_article;
    if (!t) continue;
    if (!articleStats[t]) articleStats[t] = { ups: 0, downs: 0 };
    if (entry.rating === 'up') articleStats[t].ups++;
    else                        articleStats[t].downs++;
  }
  const rankedArticles = Object.entries(articleStats)
    .map(([title, s]) => ({
      title,
      ups:       s.ups,
      downs:     s.downs,
      total:     s.ups + s.downs,
      score_pct: s.ups + s.downs ? `${Math.round(s.ups / (s.ups + s.downs) * 100)}%` : 'n/a',
    }))
    .sort((a, b) => b.total - a.total);

  res.json({
    summary: { total, ups, downs, helpful_rate: total ? `${Math.round(ups / total * 100)}%` : 'n/a' },
    article_stats: rankedArticles,
    entries: feedbackLog.slice().reverse(),
  });
});

app.get('/health', (req, res) => res.json({ ok: true, cached: articleCache?.length || 0, enriched: articleCache?.filter(a => a.extractedKeywords).length || 0 }));

getArticles().catch(err => console.error('Cache warm failed:', err.message));

app.listen(process.env.PORT || 3000, () => console.log('KokoBrain app running'));
