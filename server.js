const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
app.use(express.json());

// Cache for scraped content
let contentCache = null;
let lastCacheUpdate = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const searchUI = {
  canvas: {
    content: {
      components: [
        { type: "text", text: "🧠 KokoBrain Search", style: "header" },
        { type: "text", text: "Search your internal knowledge base to help customers", style: "muted" },
        { type: "spacer", size: "s" },
        {
          type: "input",
          id: "search_query",
          label: "Search",
          placeholder: "e.g. eSIM activation, data not working, refund...",
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

// Handle both GET and POST for initialize
app.get('/intercom/initialize', (req, res) => {
  res.json(searchUI);
});

app.post('/intercom/initialize', (req, res) => {
  res.json(searchUI);
});

// Handle both GET and POST for submit
app.get('/intercom/submit', async (req, res) => {
  res.json(searchUI);
});

app.post('/intercom/submit', async (req, res) => {
  const query = req.body.input_values?.search_query;

  if (req.body.component_id === 'back_btn' || !query) {
    return res.json(searchUI);
  }

  try {
    console.log(`🔍 Searching KokoBrain for: "${query}"`);
    const articles = await searchKokoBrainIntelligent(query);
    console.log(`✅ Found ${articles.length} matching articles`);
    res.json({ canvas: buildResultsCanvas(query, articles) });
  } catch (err) {
    console.error('❌ KokoBrain search error:', err);
    res.json({ canvas: buildErrorCanvas() });
  }
});

// Intelligent KokoBrain search with content crawling
async function searchKokoBrainIntelligent(query) {
  try {
    // Get fresh content if cache is stale
    if (!contentCache || Date.now() - lastCacheUpdate > CACHE_DURATION) {
      console.log('🔄 Refreshing KokoBrain content cache...');
      contentCache = await crawlKokoBrainContent();
      lastCacheUpdate = Date.now();
      console.log(`📚 Cached ${contentCache.length} articles`);
    }

    // Search through cached content
    return searchCachedContent(contentCache, query);
  } catch (error) {
    console.error('Error in intelligent search:', error);
    return [];
  }
}

// Crawl and parse KokoBrain content
async function crawlKokoBrainContent() {
  const articles = [];
  
  try {
    console.log('🕷️ Crawling kokobrain.lovable.app...');
    
    // Fetch main page
    const response = await fetch('https://kokobrain.lovable.app', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KoletBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`📄 Retrieved ${html.length} characters from main page`);

    // Extract content using multiple parsing strategies
    const parsedArticles = await parseKokoBrainHTML(html);
    articles.push(...parsedArticles);

    // Try to find and crawl additional pages
    const additionalUrls = extractAdditionalUrls(html);
    console.log(`🔗 Found ${additionalUrls.length} additional URLs to crawl`);

    // Crawl up to 5 additional pages
    for (const url of additionalUrls.slice(0, 5)) {
      try {
        const pageResponse = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KoletBot/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });

        if (pageResponse.ok) {
          const pageHtml = await pageResponse.text();
          const pageArticles = await parseKokoBrainHTML(pageHtml, url);
          articles.push(...pageArticles);
          console.log(`📄 Crawled ${url} - found ${pageArticles.length} articles`);
        }
      } catch (pageError) {
        console.log(`⚠️ Failed to crawl ${url}:`, pageError.message);
      }
      
      // Small delay to be respectful
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`✅ Total crawled articles: ${articles.length}`);
    return articles;

  } catch (error) {
    console.error('❌ Crawling failed:', error);
    return [];
  }
}

// Parse HTML content and extract articles
async function parseKokoBrainHTML(html, sourceUrl = 'https://kokobrain.lovable.app') {
  const articles = [];
  
  try {
    // Clean up HTML
    const cleanHtml = html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<!--.*?-->/gis, '');

    // Extract meaningful content blocks
    const contentBlocks = extractContentBlocks(cleanHtml);
    
    for (const block of contentBlocks) {
      if (block.title && block.content) {
        articles.push({
          title: block.title.trim(),
          description: block.content.substring(0, 200).trim() + '...',
          content: block.content.trim(),
          url: sourceUrl,
          searchText: `${block.title} ${block.content}`.toLowerCase()
        });
      }
    }

    // If no structured content found, create general article
    if (articles.length === 0) {
      const generalContent = extractGeneralContent(cleanHtml);
      if (generalContent) {
        articles.push({
          title: extractTitle(cleanHtml) || 'KokoBrain Knowledge Base',
          description: 'Internal knowledge base content',
          content: generalContent,
          url: sourceUrl,
          searchText: generalContent.toLowerCase()
        });
      }
    }

  } catch (error) {
    console.error('Parsing error:', error);
  }

  return articles;
}

// Extract structured content blocks
function extractContentBlocks(html) {
  const blocks = [];
  
  // Strategy 1: Look for heading + content pairs
  const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
  const headings = [...html.matchAll(headingRegex)];
  
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const title = stripHtml(heading[2]);
    
    // Get content between this heading and the next
    const startPos = heading.index + heading[0].length;
    const endPos = i < headings.length - 1 ? headings[i + 1].index : html.length;
    const contentSection = html.substring(startPos, endPos);
    
    // Extract text content
    const content = extractTextFromSection(contentSection);
    
    if (title.length > 2 && content.length > 20) {
      blocks.push({ title, content });
    }
  }

  // Strategy 2: Look for article/section tags
  const articleRegex = /<(article|section)[^>]*>(.*?)<\/\1>/gis;
  const articles = [...html.matchAll(articleRegex)];
  
  for (const article of articles) {
    const content = extractTextFromSection(article[2]);
    const title = extractFirstHeading(article[2]) || `Article ${blocks.length + 1}`;
    
    if (content.length > 20) {
      blocks.push({ title, content });
    }
  }

  return blocks;
}

// Extract text content from HTML section
function extractTextFromSection(html) {
  return stripHtml(html)
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip HTML tags
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

// Extract title from HTML
function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) return stripHtml(titleMatch[1]);
  
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match) return stripHtml(h1Match[1]);
  
  return null;
}

// Extract first heading from section
function extractFirstHeading(html) {
  const headingMatch = html.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
  return headingMatch ? stripHtml(headingMatch[1]) : null;
}

// Extract general content if no structure found
function extractGeneralContent(html) {
  const textElements = html.match(/<p[^>]*>(.*?)<\/p>/gi) || [];
  const content = textElements
    .map(p => stripHtml(p))
    .filter(text => text.length > 10)
    .join(' ')
    .replace(/\s+/g, ' ');
  
  return content.length > 50 ? content : null;
}

// Extract additional URLs to crawl
function extractAdditionalUrls(html) {
  const urls = [];
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    let url = match[1];
    
    // Convert relative URLs to absolute
    if (url.startsWith('/')) {
      url = 'https://kokobrain.lovable.app' + url;
    } else if (!url.startsWith('http')) {
      url = 'https://kokobrain.lovable.app/' + url;
    }
    
    // Only include kokobrain.lovable.app URLs
    if (url.includes('kokobrain.lovable.app') && !urls.includes(url)) {
      urls.push(url);
    }
  }
  
  return urls;
}

// Search through cached content
function searchCachedContent(articles, query) {
  if (!articles || articles.length === 0) {
    return [];
  }

  const q = query.toLowerCase();
  const results = [];

  for (const article of articles) {
    let score = 0;
    const searchText = article.searchText || `${article.title} ${article.content}`.toLowerCase();

    // Exact phrase match in title (highest score)
    if (article.title.toLowerCase().includes(q)) {
      score += 100;
    }

    // Exact phrase match in content
    if (searchText.includes(q)) {
      score += 50;
    }

    // Individual word matches
    const queryWords = q.split(' ').filter(word => word.length > 2);
    for (const word of queryWords) {
      const wordCount = (searchText.match(new RegExp(word, 'g')) || []).length;
      score += wordCount * 10;
    }

    if (score > 0) {
      results.push({
        ...article,
        score
      });
    }
  }

  // Sort by score and return top 5
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...article }) => article);
}

function buildResultsCanvas(query, articles) {
  const components = [
    { type: "text", text: `🧠 Results for "${query}"`, style: "header" },
    { type: "divider" }
  ];

  if (articles.length === 0) {
    components.push({
      type: "text",
      text: "No articles found in KokoBrain. The content might not be cached yet, or try different keywords.",
      style: "muted"
    });
  } else {
    for (const article of articles) {
      components.push({ 
        type: "text", 
        text: `📄 ${article.title}`, 
        style: "paragraph" 
      });
      components.push({ 
        type: "text", 
        text: article.description, 
        style: "muted" 
      });
      components.push({ 
        type: "anchor", 
        href: article.url, 
        text: "Open in KokoBrain →" 
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
        { type: "text", text: "⚠️ Search temporarily unavailable. Please try again.", style: "muted" },
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

app.listen(process.env.PORT || 3000, () => console.log('✅ KokoBrain intelligent search app running'));
