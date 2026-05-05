const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
app.use(express.json());

// --- Debug: store last request bodies ---
let lastInit = {};
let lastSubmit = {};

// --- Notion cache ---
let articleCache = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchPageText(pageId) {
  try {
    const res = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`,
      {
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        },
      }
    );
    const data = await res.json();
    if (!res.ok) return '';
    return (data.results || [])
      .map(block => {
        const type = block.type;
        const richText = block[type]?.rich_text || [];
        return richText.map(t => t.plain_text).join('');
      })
      .join(' ')
      .toLowerCase();
  } catch {
    return '';
  }
}

async function getArticles() {
  if (articleCache && Date.now() < cacheExpiry) return articleCache;

  const results = [];
  let cursor = undefined;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
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

      results.push({ title, category, keywords, content: '', url, pageId: page.id });
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  articleCache = results;
  cacheExpiry = Date.now() + CACHE_TTL;
  console.log(`Cached ${results.length} articles`);

  // Fetch page content in background (3 at a time, 300ms gap to avoid rate limits)
  enrichArticleContent(results);

  return results;
}

async function enrichArticleContent(articles) {
  for (let i = 0; i < articles.length; i += 3) {
    const batch = articles.slice(i, i + 3);
    await Promise.all(
      batch.map(async (article) => {
        if (!article.content) {
          article.content = await fetchPageText(article.pageId);
        }
      })
    );
    if (i + 3 < articles.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log('Article content enrichment complete');
}

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

// Customer language → article terms. Each key maps to terms likely in article titles/categories.
const SYNONYMS = {
  refund:       ['money back','reimburse','reimbursement','cashback','cancel','cancelled'],
  money:        ['refund','payment','invoice','wallet','credit','koin','koins'],
  payment:      ['invoice','pay','paid','charge','billing','bill','receipt'],
  invoice:      ['receipt','bill','billing','charge'],
  wallet:       ['credit','credits','balance','koin','koins','top up','topup'],
  install:      ['installation','setup','set up','activate','activation','qr','scan','add esim'],
  transfer:     ['move','switch','reassign','new phone','new device','change device','migrate','migration'],
  connection:   ['connect','connectivity','signal','network','no data','internet','roaming','apn'],
  internet:     ['connection','data','connectivity','apn','network'],
  slow:         ['speed','slow connection','connectivity'],
  login:        ['sign in','log in','otp','password','access','verification','code'],
  account:      ['login','profile','delete','unsubscribe'],
  crash:        ['crash','bug','app','force close','not opening'],
  esim:         ['sim','profile','qr code','qr','compatible','compatibility'],
  data:         ['gb','gigabyte','plan','package','usage','extend','bundle'],
  blocked:      ['fraud','ban','banned','suspended','disposable','email'],
  fraud:        ['scam','suspicious','blocked','fake','disposable'],
  referral:     ['refer','invite','friend','voucher','code','promo','gift','discount','coupon'],
  voucher:      ['referral','promo','code','gift','discount','coupon','expired'],
  roaming:      ['connection','apn','network','abroad','travel','international'],
  sms:          ['otp','verification','code','text message'],
  miles:        ['flying blue','afklm','air france','klm','points','loyalty','mileage'],
  partner:      ['travel partner','airline','afklm','air france','flying blue'],
};

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
    for (const [key, syns] of Object.entries(SYNONYMS)) {
      if (syns.some(s => s === word)) {
        expanded.add(key);
        syns.forEach(s => expanded.add(s));
      }
    }
  }

  return { terms: Array.from(expanded), boostConcepts: Array.from(conceptBoosts) };
}

function scoreText(text, terms, phrase) {
  let score = 0;
  if (phrase && text.includes(phrase)) score += 50;
  for (const term of terms) {
    if (text.includes(term)) score += term.includes(' ') ? 30 : 15; // phrases score more
  }
  return score;
}

function searchArticles(articles, rawQuery) {
  const q = sanitizeQuery(rawQuery);
  if (!q) return [];

  // Split, remove stopwords, keep known short terms (gb, eu, uk, qr)
  const KEEP_SHORT = new Set(['gb','eu','uk','qr','us','fr']);
  const rawWords = q.split(/\s+/).filter(w =>
    (w.length > 2 || KEEP_SHORT.has(w)) && !STOPWORDS.has(w)
  );
  if (rawWords.length === 0) return [];

  const { terms: expanded, boostConcepts } = expandTerms(rawWords, q);

  const scored = articles.map(article => {
    const title    = article.title.toLowerCase();
    const category = article.category.toLowerCase();
    const keywords = article.keywords;
    const content  = article.content || '';
    let score = 0;

    // Exact / phrase match on full query
    if (title === q)            score += 400;
    else if (title.includes(q)) score += 200;
    if (category.includes(q))   score += 80;
    if (keywords.includes(q))   score += 60;
    if (content.includes(q))    score += 50;

    // Expanded term scoring across all fields
    score += scoreText(title,    expanded, q) * 2;  // title weighted 2x
    score += scoreText(category, expanded, q);
    score += scoreText(keywords, expanded, q);
    score += scoreText(content,  expanded, q);

    // Concept boost: phrase match confirmed the intent → heavily reward title hits
    for (const concept of boostConcepts) {
      if (title.includes(concept))    score += 200;
      if (category.includes(concept)) score += 80;
      if (keywords.includes(concept)) score += 60;
    }

    // Prefix match on individual title words
    const titleTokens = title.split(/[\s:,\-&()]+/);
    for (const word of rawWords) {
      for (const token of titleTokens) {
        if (token && (token.startsWith(word) || word.startsWith(token))) score += 15;
      }
    }

    return { ...article, score };
  });

  // Return all scored articles — callers apply context boosts then slice
  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score);
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

function extractContactContext(body) {
  const contact = body.contact || {};
  const attrs   = contact.custom_attributes || {};

  const esimStatus = (
    attrs.esim_status ||
    attrs.latest_sparks_esim_status ||
    attrs.latest_lanck_esim_status || ''
  ).toLowerCase();

  const partnerSlug = (attrs.initial_referrer_partner_slug || '').toLowerCase().replace(/ /g, '_');

  return {
    isIOS:          !!contact.ios_device || !!contact.ios_app_version,
    isAndroid:      !!contact.android_device || !!contact.android_app_version,
    esimStatus,                                         // 'installed','uninstalled','enabled','disabled',''
    esimCompatible: attrs.is_device_esim_compatible,   // true | false | null
    fraudSuspected: attrs.fraud_suspected === true,
    partnerSlug,                                        // e.g. 'fram', 'afklm'
    partnerKeyword: PARTNER_TITLE_MAP[partnerSlug] ?? partnerSlug,
    isB2B:          attrs.is_b2b === true,
    language:       attrs.language || '',
  };
}

function applyContextBoosts(allArticles, scored, ctx) {
  if (!ctx) return scored.slice(0, 5);

  const esimInstalled   = /installed|enabled|active/.test(ctx.esimStatus);
  const esimUninstalled = /uninstalled|not_installed|deleted/.test(ctx.esimStatus);
  const esimDisabled    = /disabled/.test(ctx.esimStatus);

  // Build a set of article URLs already in scored results
  const scoredUrls = new Set(scored.map(a => a.url));

  // Articles to force-inject based on strong context signals (even if text score = 0)
  const injected = [];

  if (ctx.partnerKeyword) {
    allArticles
      .filter(a => a.title.toLowerCase().includes(ctx.partnerKeyword) && !scoredUrls.has(a.url))
      .forEach(a => injected.push({ ...a, score: 250 }));
  }
  if (ctx.fraudSuspected) {
    allArticles
      .filter(a => a.category.toLowerCase().includes('fraud') && !scoredUrls.has(a.url))
      .forEach(a => injected.push({ ...a, score: 180 }));
  }
  if (ctx.esimCompatible === false) {
    allArticles
      .filter(a => (a.title.toLowerCase().includes('adapter') || a.title.toLowerCase().includes('compatible')) && !scoredUrls.has(a.url))
      .forEach(a => injected.push({ ...a, score: 200 }));
  }

  const combined = [...scored, ...injected];

  return combined.map(article => {
    let bonus = 0;
    const title    = article.title.toLowerCase();
    const category = article.category.toLowerCase();

    if (esimUninstalled) {
      if (category.includes('install'))                                  bonus += 150;
      if (category.includes('connect') || category.includes('start'))   bonus -=  20;
    }
    if (esimInstalled) {
      if (category.includes('connect') || category.includes('start'))   bonus +=  80;
      if (category.includes('install') &&
          !title.includes('reassign') && !title.includes('transfer') &&
          !title.includes('move'))                                        bonus -=  30;
    }
    if (esimDisabled) {
      if (category.includes('connect'))                                  bonus +=  60;
      if (category.includes('account'))                                  bonus +=  40;
    }
    if (ctx.esimCompatible === false) {
      if (title.includes('adapter') || title.includes('compatible'))    bonus += 200;
    }
    if (ctx.partnerKeyword) {
      if (title.includes(ctx.partnerKeyword))                           bonus += 250;
      else if (category.includes('travel partner'))                     bonus +=  40;
    }
    if (ctx.fraudSuspected) {
      if (category.includes('fraud'))                                   bonus += 180;
    }
    if (ctx.isB2B) {
      if (title.includes('b2b') || title.includes('business'))         bonus += 150;
    }
    if (ctx.isAndroid && title.includes('pixel'))                       bonus +=  60;
    if (ctx.isIOS    && title.includes('pixel'))                        bonus -=  40;

    return { ...article, score: Math.max(0, article.score + bonus) };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function extractConversationText(body) {
  const conv = body.conversation || {};
  const parts = [
    conv.source?.subject,
    conv.source?.body,
    conv.first_contact_reply?.body,
  ].filter(Boolean);

  return parts
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Canvas builders ---

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

function buildSuggestionsCanvas(articles, convQuery, ctx) {
  const components = [
    ...searchInputComponents(),
    { type: "divider" },
    { type: "text", text: "Suggested articles", style: "header" },
  ];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    components.push({ type: "divider" });
    if (article.category) {
      components.push({ type: "text", text: article.category, style: "muted" });
    }
    components.push({
      type: "button",
      id: `open_${i}`,
      label: article.title,
      style: "link",
      action: { type: "url", url: article.url }
    });
  }

  return {
    canvas: {
      stored_data: { conv_query: convQuery, ctx: ctx || null },
      content: { components }
    }
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

function buildResultsCanvas(headerText, articles, convQuery, ctx) {
  const components = [
    ...searchInputComponents(),
    { type: "divider" },
    { type: "text", text: headerText, style: "header" },
  ];

  if (articles.length === 0) {
    components.push({ type: "text", text: "No articles found.", style: "muted" });
  } else {
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      components.push({ type: "divider" });
      if (article.category) {
        components.push({ type: "text", text: article.category, style: "muted" });
      }
      components.push({
        type: "button",
        id: `open_${i}`,
        label: article.title,
        style: "link",
        action: { type: "url", url: article.url }
      });
    }
  }

  // Back to suggestions only if there was a conversation context
  if (convQuery) {
    components.push({ type: "divider" });
    components.push({
      type: "button",
      id: "back_btn",
      label: "← Back to suggestions",
      style: "secondary",
      action: { type: "submit" }
    });
  }

  return {
    canvas: {
      stored_data: { conv_query: convQuery || '', ctx: ctx || null },
      content: { components }
    }
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

app.post('/intercom/initialize', async (req, res) => {
  lastInit = req.body;
  console.log('INIT component_id:', req.body.component_id);
  console.log('INIT input_values:', JSON.stringify(req.body.input_values));
  console.log('INIT conversation text:', extractConversationText(req.body).slice(0, 200));

  const convText = extractConversationText(req.body);

  const ctx = extractContactContext(req.body);
  console.log('Context:', JSON.stringify(ctx));

  if (convText) {
    try {
      const articles = await getArticles();
      const rawResults = searchArticles(articles, convText);
      const suggestions = applyContextBoosts(articles, rawResults, ctx);
      if (suggestions.length > 0) {
        console.log(`Auto-suggested ${suggestions.length} articles (with context boosts)`);
        return res.json(buildSuggestionsCanvas(suggestions, convText, ctx));
      }
    } catch (err) {
      console.error('Auto-suggest error:', err.message);
    }
  }

  res.json(searchOnlyCanvas);
});

app.post('/intercom/submit', async (req, res) => {
  lastSubmit = req.body;
  console.log('SUBMIT component_id:', req.body.component_id);
  console.log('SUBMIT input_values:', JSON.stringify(req.body.input_values));

  const componentId    = req.body.component_id || '';
  const storedData     = req.body.canvas_data?.stored_data || {};
  const storedConvQuery = storedData.conv_query || '';
  const storedCtx      = storedData.ctx || null;

  // URL buttons open Notion directly — no state change needed
  if (componentId.startsWith('open_')) {
    return res.status(200).end();
  }

  // Back to suggestions
  if (componentId === 'back_btn' && storedConvQuery) {
    try {
      const articles = await getArticles();
      const rawResults = searchArticles(articles, storedConvQuery);
      const suggestions = applyContextBoosts(articles, rawResults, storedCtx);
      return res.json(buildSuggestionsCanvas(suggestions, storedConvQuery, storedCtx));
    } catch (err) {
      console.error('Back error:', err.message);
      return res.json(searchOnlyCanvas);
    }
  }

  const rawQuery = req.body.input_values?.search_query;
  const query = sanitizeQuery(rawQuery);

  console.log(`Raw query: "${rawQuery}" → sanitized: "${query}"`);

  if (!query) {
    return res.json(searchOnlyCanvas);
  }

  try {
    const articles = await getArticles();
    const rawResults = searchArticles(articles, query);
    const results = applyContextBoosts(articles, rawResults, storedCtx);
    console.log(`Found ${results.length} results for "${query}" (context: esim=${storedCtx?.esimStatus}, partner=${storedCtx?.partnerSlug})`);
    return res.json(buildResultsCanvas(`Results for "${query}"`, results, storedConvQuery, storedCtx));
  } catch (err) {
    console.error('Search error:', err.message);
    return res.json(buildErrorCanvas());
  }
});

// Debug endpoints
app.get('/debug/last-init', (req, res) => res.json(lastInit));
app.get('/debug/last-submit', (req, res) => res.json(lastSubmit));
app.get('/debug/search', async (req, res) => {
  const q = req.query.q || '';
  const articles = await getArticles();
  const results = searchArticles(articles, q);
  res.json({ query: q, sanitized: sanitizeQuery(q), count: results.length, results });
});
app.get('/health', (req, res) => res.json({ ok: true, cached: articleCache?.length || 0 }));

getArticles().catch(err => console.error('Cache warm failed:', err.message));

app.listen(process.env.PORT || 3000, () => console.log('KokoBrain app running'));
