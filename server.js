const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
app.use(express.json());

// --- Notion cache ---
let articleCache = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
          'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
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

      results.push({ title, category, keywords, url });
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  articleCache = results;
  cacheExpiry = Date.now() + CACHE_TTL;
  console.log(`📚 Cached ${results.length} articles from Notion`);
  return results;
}

function searchArticles(articles, query) {
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/);

  const scored = articles.map(article => {
    const titleLower = article.title.toLowerCase();
    const categoryLower = article.category.toLowerCase();
    let score = 0;

    if (titleLower === q) score += 200;
    else if (titleLower.includes(q)) score += 100;
    if (categoryLower.includes(q)) score += 50;
    if (article.keywords.includes(q)) score += 40;

    for (const word of words) {
      if (word.length < 2) continue;
      if (titleLower.includes(word)) score += 30;
      if (categoryLower.includes(word)) score += 20;
      if (article.keywords.includes(word)) score += 10;
    }

    return { ...article, score };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// --- Canvas UI ---
const searchUI = {
  canvas: {
    content: {
      components: [
        { type: "text", text: "🧠 KokoBrain Search", style: "header" },
        { type: "text", text: "Search the internal knowledge base", style: "muted" },
        { type: "spacer", size: "s" },
        {
          type: "input",
          id: "search_query",
          label: "Search",
          placeholder: "e.g. refund, eSIM install, no connection...",
          action: { type: "submit" }
        },
        {
          type: "button",
          id: "search_btn",
          label: "Search KokoBrain",
          style: "primary",
          action: { type: "submit" }
        }
      ]
    }
  }
};

function buildResultsCanvas(query, articles) {
  const components = [
    { type: "text", text: `🧠 Results for "${query}"`, style: "header" },
    { type: "divider" }
  ];

  if (articles.length === 0) {
    components.push({
      type: "text",
      text: "No articles found. Try different keywords.",
      style: "muted"
    });
  } else {
    for (const article of articles) {
      if (article.category) {
        components.push({ type: "text", text: article.category, style: "muted" });
      }
      components.push({ type: "text", text: `📄 ${article.title}`, style: "paragraph" });
      components.push({
        type: "button",
        label: "Open in Notion →",
        style: "link",
        action: { type: "url", url: article.url }
      });
      components.push({ type: "spacer", size: "s" });
    }
  }

  components.push({ type: "divider" });
  components.push({
    type: "button",
    id: "back_btn",
    label: "← New Search",
    style: "secondary",
    action: { type: "submit" }
  });

  return { content: { components } };
}

function buildErrorCanvas() {
  return {
    content: {
      components: [
        { type: "text", text: "⚠️ Could not reach Notion. Please try again.", style: "muted" },
        {
          type: "button",
          id: "back_btn",
          label: "← Back",
          style: "secondary",
          action: { type: "submit" }
        }
      ]
    }
  };
}

// --- Routes ---
app.post('/intercom/initialize', (req, res) => {
  res.json(searchUI);
});

app.get('/intercom/initialize', (req, res) => {
  res.json(searchUI);
});

app.post('/intercom/submit', async (req, res) => {
  const query = req.body.input_values?.search_query;

  if (req.body.component_id === 'back_btn' || !query) {
    return res.json(searchUI);
  }

  console.log(`🔍 Searching KokoBrain for: "${query}"`);

  try {
    const articles = await getArticles();
    const results = searchArticles(articles, query);
    console.log(`✅ Found ${results.length} matching articles`);
    res.json({ canvas: buildResultsCanvas(query, results) });
  } catch (err) {
    console.error('Search error:', err.message);
    res.json({ canvas: buildErrorCanvas() });
  }
});

// Warm the cache on startup
getArticles().catch(err => console.error('Cache warm failed:', err.message));

app.listen(process.env.PORT || 3000, () => console.log('✅ KokoBrain app running'));
