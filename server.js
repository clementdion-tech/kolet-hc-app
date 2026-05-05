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

function sanitizeQuery(raw) {
  if (!raw) return '';
  // Strip anything that isn't a letter, digit, space, hyphen, or apostrophe
  return raw.replace(/[^\w\s\-']/g, '').trim().toLowerCase();
}

function searchArticles(articles, rawQuery) {
  const q = sanitizeQuery(rawQuery);
  if (!q) return [];

  const words = q.split(/\s+/).filter(w => w.length > 1);

  const scored = articles.map(article => {
    const titleLower = article.title.toLowerCase();
    const categoryLower = article.category.toLowerCase();
    const keywordsLower = article.keywords;
    const contentLower = article.content || '';
    let score = 0;

    // Exact title match
    if (titleLower === q) score += 300;
    else if (titleLower.includes(q)) score += 150;

    // Category match
    if (categoryLower.includes(q)) score += 60;

    // Keyword field match
    if (keywordsLower.includes(q)) score += 50;

    // Full content match
    if (contentLower.includes(q)) score += 40;

    // Per-word scoring
    for (const word of words) {
      if (titleLower.includes(word)) score += 40;
      if (categoryLower.includes(word)) score += 20;
      if (keywordsLower.includes(word)) score += 15;
      if (contentLower.includes(word)) score += 10;

      // Prefix match: "refund" matches "refunds"
      const titleWords = titleLower.split(/[\s:,\-&]+/);
      for (const tw of titleWords) {
        if (tw.startsWith(word) || word.startsWith(tw)) score += 20;
      }
    }

    return { ...article, score };
  });

  return scored
    .filter(a => a.score > 0)
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

function buildSuggestionsCanvas(articles, convQuery) {
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
      stored_data: { conv_query: convQuery },
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

function buildResultsCanvas(headerText, articles, convQuery) {
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
      stored_data: { conv_query: convQuery || '' },
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

  if (convText) {
    try {
      const articles = await getArticles();
      const suggestions = searchArticles(articles, convText);
      if (suggestions.length > 0) {
        console.log(`Auto-suggested ${suggestions.length} articles for: "${convText.slice(0, 80)}"`);
        return res.json(buildSuggestionsCanvas(suggestions, convText));
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

  const componentId = req.body.component_id || '';
  const storedConvQuery = req.body.canvas_data?.stored_data?.conv_query || '';

  // URL buttons open Notion directly — no state change needed
  if (componentId.startsWith('open_')) {
    return res.status(200).end();
  }

  // Back to suggestions
  if (componentId === 'back_btn' && storedConvQuery) {
    try {
      const articles = await getArticles();
      const suggestions = searchArticles(articles, storedConvQuery);
      return res.json(buildSuggestionsCanvas(suggestions, storedConvQuery));
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
    const results = searchArticles(articles, query);
    console.log(`Found ${results.length} results for "${query}"`);
    return res.json(buildResultsCanvas(`Results for "${query}"`, results, storedConvQuery));
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
