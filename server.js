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

// Recursively fetch all block text up to MAX_DEPTH levels (handles toggles, callouts, lists, tables)
const MAX_BLOCK_DEPTH = 3;

async function fetchBlocksText(blockId, depth = 0) {
  try {
    const res = await fetch(
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

      results.push({ title, category, keywords, content: '', extractedKeywords: '', url, pageId: page.id });
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

// Domain terms we always want to catch even if they appear only once
const DOMAIN_TERMS = new Set([
  'esim','sim','apn','iccid','qr','roaming','refund','invoice','wallet',
  'koin','koins','fraud','install','activate','activation','connectivity',
  'compatible','compatibility','profile','carrier','network','plan','bundle',
  'expire','transfer','reassign','reassignment','migrate','migration','voucher','referral',
  'promo','miles','loyalty','partner','otp','verification','password',
  'login','account','billing','payment','credit','balance','topup','adapter',
  'android','iphone','pixel','samsung','huawei','xiaomi','oppo',
  'restricted','blocked','government','vpn','zone','country','egypt','turkey',
  'china','flying','blue','afklm','airfrance','klm','oneclick','qrcode',
  'reimbursement','cashback','uninstall','reinstall','reactivate','disable',
  'enabled','disabled','installed','detected','coverage','bandwidth','speed',
  'throttle','expire','renewal','extend','top','topup','b2b','enterprise',
  // eSIM types & labels users actually see on their device
  'sparks','lanck','valid','plus','tim','proximus',
  // eSIM/device troubleshooting terms
  'imei','sos','greyed','grayed','defective','reassign','subscription',
  'nperf','relay','privaterelay','domain','disposable',
  // New from conversation analysis
  'locate','locate esim','find esim','secondary','countdown','validity','consent',
  'gift','donation','convert','unused','koins','koin','remaining','leftover',
  'terms','conditions','checkbox','bezahlen','paiement','pagare','throttled',
  'primary','data sim','primary sim','service','signal','destination',
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
          article.content          = await fetchBlocksText(article.pageId);
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
  // NEW — "find / locate eSIM in phone settings" (different from install problems)
  locate:       ['find my esim','cant find','cannot find','not showing','not visible','not appearing',
                 'disappeared','where is my esim','see my esim','show esim','secondary sim',
                 'business line','travel sim','mobile data label','which sim is kolet',
                 'find esim','locate esim','see esim','esim not showing','esim disappeared',
                 // Device label confusion — eSIM shows as Plus/TIM/Orange/Proximus, not "Kolet"
                 'kolet plus','kolet tim','kolet lt','kolet sp','kolet lo','kolet orange',
                 'shows as plus','shows as tim','called plus','called tim','named plus','named tim',
                 'plus sim','tim sim','orange sim','proximus sim','sim called','which is mine',
                 'two sims','two sim cards','which line is','my esim is called'],

  // ── Connectivity ─────────────────────────────────────────────────────────
  connection:   ['connect','connectivity','signal','network','no data','internet','roaming','apn',
                 'not connecting','not working','no service','no internet','not getting service',
                 'sos','sos only','greyed','greyed out','grayed','grayed out','grey toggle',
                 'gray toggle','toggle grey','toggle gray','esim greyed','toggle disabled'],
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
  // NEW — data gifting / donation (distinct from device transfer)
  gift:         ['gift data','gifted','gift my gb','data donation','donate data','wrong email',
                 'recipient','receiver','reciever','regalo','cadeau','gifted to wrong','sent to wrong'],

  // ── Koins / convert unused data ──────────────────────────────────────────
  // NEW — Koins are frequently asked about but were missing from SYNONYMS entirely
  koins:        ['koin','kolet koins','remaining credit','in-app credit','wallet credit',
                 'crédit restant','utiliser le crédit','use my credit','convert data',
                 'convert unused','unused data','données inutilisées','reconvertir',
                 'how do i use koins','use koins'],
  // NEW — explicit "convert" intent
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

  // ── Fraud / blocked accounts ─────────────────────────────────────────────
  blocked:      ['fraud','ban','banned','suspended','disposable','email',
                 'fraudster','stolen','compromised','hacked','hijacked'],
  fraud:        ['scam','suspicious','blocked','fake','disposable',
                 'fraudster','stolen','compromised','unauthorized','fraudulent'],
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
    const keywords = article.keywords;                    // manual Notion keywords
    const extkw    = article.extractedKeywords || '';     // auto-extracted knowledge base
    const content  = article.content || '';
    let score = 0;

    // Exact / phrase match on full query
    if (title === q)            score += 400;
    else if (title.includes(q)) score += 200;
    if (category.includes(q))   score += 80;
    if (keywords.includes(q))   score += 60;
    if (extkw.includes(q))      score += 55;
    if (content.includes(q))    score += 40;

    // Expanded term scoring across all fields
    score += scoreText(title,    expanded, q) * 2;  // title weighted 2×
    score += scoreText(category, expanded, q);
    score += scoreText(keywords, expanded, q);
    score += scoreText(extkw,    expanded, q);       // knowledge base on par with manual keywords
    score += scoreText(content,  expanded, q) * 0.5; // raw content lower weight (noisy)

    // Concept boost: phrase match confirmed the intent → heavily reward title hits
    for (const concept of boostConcepts) {
      if (title.includes(concept))    score += 200;
      if (category.includes(concept)) score += 80;
      if (keywords.includes(concept)) score += 60;
      if (extkw.includes(concept))    score += 55;
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

// Countries where eSIM is blocked / heavily restricted
const RESTRICTED_COUNTRIES = new Set(['eg','egy','egypt','tr','tur','turkey','cn','china']);

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

  // Chinese-market device brands often have eSIM installation quirks
  const CHINESE_BRANDS = new Set(['oppo','huawei','xiaomi','oneplus','realme','vivo','honor','zte','meizu','lenovo','tcl','tecno','infinix','nothing']);
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

  const title    = article.title.toLowerCase();
  const category = article.category.toLowerCase();

  const esimInstalled   = /installed|enabled|active/.test(ctx.esimStatus);
  const esimUninstalled = /uninstalled|not_installed|deleted/.test(ctx.esimStatus);
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
  if (title.includes('find') || title.includes('locat') || title.includes('see') ||
      title.includes('show') || title.includes('visible') || title.includes('appear')) {
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

function applyContextBoosts(allArticles, scored, ctx) {
  if (!ctx) return scored.slice(0, 5);

  const esimInstalled   = /installed|enabled|active/.test(ctx.esimStatus);
  const esimUninstalled = /uninstalled|not_installed|deleted/.test(ctx.esimStatus);
  const esimDisabled    = /disabled/.test(ctx.esimStatus);
  const neverConnected  = esimInstalled && ctx.esimLastCountry === null;

  // Force-inject articles for strong context signals even when text score = 0
  const scoredUrls = new Set(scored.map(a => a.url));
  const injected   = [];

  function inject(articles, filterFn, baseScore) {
    articles.filter(a => filterFn(a) && !scoredUrls.has(a.url))
      .forEach(a => { injected.push({ ...a, score: baseScore }); scoredUrls.add(a.url); });
  }

  if (ctx.partnerKeyword) {
    inject(allArticles, a => a.title.toLowerCase().includes(ctx.partnerKeyword), 250);
  }
  if (ctx.fraudSuspected) {
    inject(allArticles, a => a.category.toLowerCase().includes('fraud'), 200);
  }
  if (ctx.esimCompatible === false) {
    inject(allArticles, a => a.title.toLowerCase().includes('adapter') || a.title.toLowerCase().includes('compatible'), 220);
  }
  if (ctx.isRestrictedCountry) {
    inject(allArticles, a => {
      const t = a.title.toLowerCase();
      return t.includes('egyptian') || t.includes('turkish') ||
             (t.includes('blocked') && t.includes('government')) ||
             t.includes('constraint');
    }, 230);
  }
  if (ctx.hasFlyingBlue) {
    inject(allArticles, a => a.title.toLowerCase().includes('air france') || a.title.toLowerCase().includes('flying blue'), 210);
  }
  if (ctx.isB2B) {
    inject(allArticles, a => a.title.toLowerCase().includes('b2b') || a.title.toLowerCase().includes('business'), 200);
  }

  const combined = [...scored, ...injected];

  return combined.map(article => {
    let bonus = 0;
    const title    = article.title.toLowerCase();
    const category = article.category.toLowerCase();

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
    if (ctx.dataNeverUsed && esimInstalled) {
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
    if (ctx.esimInstallCount > 1) {
      if (title.includes('reassign') || title.includes('move') || title.includes('transfer')) bonus += 80;
    }

    // --- Data expired ---
    if (ctx.dataExpired) {
      if (title.includes('extend') || title.includes('renew'))         bonus += 100;
      if (category.includes('money'))                                  bonus +=  40;
    }

    // --- Restricted country ---
    if (ctx.isRestrictedCountry) {
      if (title.includes('egyptian') || title.includes('turkish') ||
          (title.includes('blocked') && title.includes('government'))) bonus += 230;
      if (title.includes('constraint'))                                bonus += 150;
    }

    // --- Partner ---
    if (ctx.partnerKeyword) {
      if (title.includes(ctx.partnerKeyword))                          bonus += 250;
      else if (category.includes('travel partner'))                    bonus +=  40;
    }

    // --- Flying Blue ---
    if (ctx.hasFlyingBlue) {
      if (title.includes('air france') || title.includes('flying blue') ||
          title.includes('afklm'))                                     bonus += 200;
      if (title.includes('miles') || title.includes('points'))        bonus +=  80;
    }

    // --- Fraud ---
    if (ctx.fraudSuspected) {
      if (category.includes('fraud'))                                  bonus += 200;
    }

    // --- B2B ---
    if (ctx.isB2B) {
      if (title.includes('b2b') || title.includes('business'))        bonus += 180;
    }

    // --- Device specifics ---
    if (ctx.isAndroid) {
      if (title.includes('pixel') || title.includes('android'))       bonus +=  60;
    }
    if (ctx.isIOS) {
      if (title.includes('pixel'))                                     bonus -=  40;
    }

    return { ...article, score: Math.max(0, article.score + bonus) };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// Extract ALL conversation text + structural signals (inbox, tags, topic)
function extractConversationContext(body) {
  const conv = body.conversation || {};

  // Collect every text chunk in the thread
  const textParts = [
    conv.source?.subject,
    conv.source?.body,
    conv.first_contact_reply?.body,
  ];
  for (const part of (conv.conversation_parts?.conversation_parts || [])) {
    if (part.body) textParts.push(part.body);
  }
  const text = textParts
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

  return { text, inboxName, tags, topic };
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

function buildSuggestionsCanvas(articles, convCtx, ctx) {
  const contextLabel = buildConvContextLabel(convCtx);

  const components = [
    ...searchInputComponents(),
    { type: "divider" },
    { type: "text", text: "Suggested articles", style: "header" },
  ];

  if (contextLabel) {
    components.push({ type: "text", text: contextLabel, style: "muted" });
  }

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const hint = getArticleHint(article, ctx);
    components.push({ type: "divider" });
    if (article.category) {
      components.push({ type: "text", text: article.category, style: "muted" });
    }
    components.push({
      type: "button",
      id: `open_${i}`,
      label: `${getArticleEmoji(article)} ${article.title}`,
      style: "link",
      action: { type: "url", url: article.url }
    });
    if (hint) {
      components.push({ type: "text", text: `⚡ ${hint}`, style: "muted" });
    }
  }

  return {
    canvas: {
      stored_data: {
        conv_query: convCtx ? buildConvSearchQuery(convCtx).slice(0, 400) : '',
        ctx: ctx || null,
        suggestion_urls: articles.map(a => a.url),
      },
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

function buildResultsCanvas(headerText, articles, convQuery, ctx, suggestionUrls = []) {
  const backButton = {
    type: "button",
    id: "back_btn",
    label: convQuery ? "← Back to suggestions" : "← Clear results",
    style: "secondary",
    action: { type: "submit" }
  };

  const components = [
    ...searchInputComponents(),
    backButton,
    { type: "divider" },
    { type: "text", text: headerText, style: "header" },
  ];

  if (articles.length === 0) {
    components.push({ type: "text", text: "No articles found.", style: "muted" });
  } else {
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const hint = getArticleHint(article, ctx);
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
      if (hint) {
        components.push({ type: "text", text: `⚡ ${hint}`, style: "muted" });
      }
    }
  }

  return {
    canvas: {
      stored_data: { conv_query: convQuery || '', ctx: ctx || null, suggestion_urls: suggestionUrls },
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
  try {
    lastInit = req.body;

    const convCtx = extractConversationContext(req.body);
    const ctx     = extractContactContext(req.body);

    console.log('INIT inbox:', convCtx.inboxName, '| topic:', convCtx.topic);
    console.log('INIT text (first 200):', convCtx.text.slice(0, 200));
    console.log('INIT esim:', ctx.esimStatus, '| partner:', ctx.partnerSlug);

    const augmentedQuery = buildConvSearchQuery(convCtx);

    if (augmentedQuery) {
      const articles    = await getArticles();
      const rawResults  = searchArticles(articles, augmentedQuery);
      const suggestions = applyContextBoosts(articles, rawResults, ctx);
      if (suggestions.length > 0) {
        console.log(`Suggested ${suggestions.length} articles for inbox="${convCtx.inboxName}"`);
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

app.post('/intercom/submit', async (req, res) => {
  try {
    lastSubmit = req.body;
    console.log('SUBMIT component_id:', req.body.component_id);

    const componentId    = req.body.component_id || '';
    const storedData     = req.body.canvas_data?.stored_data || {};
    const storedConvQuery  = storedData.conv_query || '';
    const storedCtx        = storedData.ctx || null;
    const storedSuggUrls   = storedData.suggestion_urls || [];

    // URL buttons open Notion directly — no state change needed
    if (componentId.startsWith('open_')) {
      return res.status(200).end();
    }

    // Back to suggestions (or clear results if no suggestions were shown)
    if (componentId === 'back_btn') {
      if (storedSuggUrls.length > 0) {
        const allArticles = await getArticles();
        const suggestions = storedSuggUrls
          .map(url => allArticles.find(a => a.url === url))
          .filter(Boolean);
        const backConvCtx = { text: storedConvQuery, inboxName: '', tags: [], topic: '' };
        return res.json(buildSuggestionsCanvas(suggestions, backConvCtx, storedCtx));
      }
      return res.json(searchOnlyCanvas);
    }

    const rawQuery = req.body.input_values?.search_query;
    const query    = sanitizeQuery(rawQuery);
    console.log(`Search: "${rawQuery}" -> "${query}"`);

    if (!query) return res.json(searchOnlyCanvas);

    const articles   = await getArticles();
    const rawResults = searchArticles(articles, query);
    const results    = applyContextBoosts(articles, rawResults, storedCtx);
    console.log(`Found ${results.length} for "${query}"`);
    return res.json(buildResultsCanvas(`Results for "${query}"`, results, storedConvQuery || null, storedCtx, storedSuggUrls));

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

// Debug endpoints
let lastError = {};
app.get('/debug/last-init',   (req, res) => res.json(lastInit));
app.get('/debug/last-error',  (req, res) => res.json(lastError));
app.get('/debug/last-submit', (req, res) => res.json(lastSubmit));
app.get('/debug/search', async (req, res) => {
  const q = req.query.q || '';
  const articles = await getArticles();
  const results = searchArticles(articles, q);
  res.json({ query: q, sanitized: sanitizeQuery(q), count: results.length, results });
});
app.get('/debug/kb', async (req, res) => {
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
app.get('/health', (req, res) => res.json({ ok: true, cached: articleCache?.length || 0, enriched: articleCache?.filter(a => a.extractedKeywords).length || 0 }));

getArticles().catch(err => console.error('Cache warm failed:', err.message));

app.listen(process.env.PORT || 3000, () => console.log('KokoBrain app running'));
