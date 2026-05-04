const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
app.use(express.json());

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
    const articles = await debugKokoBrainContent(query);
    console.log(`✅ Found ${articles.length} matching articles`);
    res.json({ canvas: buildResultsCanvas(query, articles) });
  } catch (err) {
    console.error('❌ KokoBrain search error:', err);
    res.json({ canvas: buildErrorCanvas() });
  }
});

async function debugKokoBrainContent(query) {
  try {
    console.log('🔄 Fetching KokoBrain content for debugging...');
    
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
    console.log(`📄 Retrieved ${html.length} characters`);

    // Debug: Log the HTML structure
    console.log('🔍 DEBUGGING HTML STRUCTURE:');
    console.log('📋 First 500 characters:', html.substring(0, 500));
    
    // Look for common content patterns
    const headings = html.match(/<h[1-6][^>]*>.*?<\/h[1-6]>/gi) || [];
    console.log(`📝 Found ${headings.length} headings:`, headings.slice(0, 3));
    
    const paragraphs = html.match(/<p[^>]*>.*?<\/p>/gi) || [];
    console.log(`📄 Found ${paragraphs.length} paragraphs`);
    
    const divs = html.match(/<div[^>]*>.*?<\/div>/gi) || [];
    console.log(`📦 Found ${divs.length} divs`);
    
    const articles = html.match(/<article[^>]*>.*?<\/article>/gi) || [];
    console.log(`📰 Found ${articles.length} article tags`);
    
    // Try to extract any text content
    const cleanText = html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`📝 Clean text length: ${cleanText.length}`);
    console.log(`📋 First 200 chars of clean text: "${cleanText.substring(0, 200)}"`);
    
    // Create searchable articles from any content we can find
    const q = query.toLowerCase();
    const results = [];
    
    // If we have headings, create articles from them
    if (headings.length > 0) {
      console.log('📝 Creating articles from headings...');
      headings.forEach((heading, index) => {
        const title = heading.replace(/<[^>]*>/g, '').trim();
        if (title.toLowerCase().includes(q)) {
          results.push({
            title: title,
            description: `Content from KokoBrain: ${title}`,
            url: 'https://kokobrain.lovable.app',
            content: title
          });
          console.log(`✅ Added heading match: "${title}"`);
        }
      });
    }
    
    // If we have clean text, search through it
    if (cleanText.length > 100 && cleanText.toLowerCase().includes(q)) {
      console.log('📝 Found query in general content');
      
      // Find the context around the query
      const lowerText = cleanText.toLowerCase();
      const queryIndex = lowerText.indexOf(q);
      const start = Math.max(0, queryIndex - 100);
      const end = Math.min(cleanText.length, queryIndex + 100);
      const context = cleanText.substring(start, end);
      
      results.push({
        title: `KokoBrain Content (contains "${query}")`,
        description: `...${context}...`,
        url: 'https://kokobrain.lovable.app',
        content: context
      });
    }
    
    // If nothing found, create a general result to show the system is working
    if (results.length === 0) {
      console.log('📝 No matches found, creating debug result');
      results.push({
        title: 'KokoBrain Debug Info',
        description: `Searched ${cleanText.length} characters for "${query}". Found ${headings.length} headings, ${paragraphs.length} paragraphs.`,
        url: 'https://kokobrain.lovable.app',
        content: cleanText.substring(0, 200)
      });
    }
    
    console.log(`🎯 Returning ${results.length} debug results`);
    return results;
    
  } catch (error) {
    console.error('❌ Debug fetch failed:', error);
    return [{
      title: 'KokoBrain Connection Issue',
      description: `Could not fetch content: ${error.message}`,
      url: 'https://kokobrain.lovable.app',
      content: 'Debug mode - connection failed'
    }];
  }
}

function buildResultsCanvas(query, articles) {
  const components = [
    { type: "text", text: `🧠 Debug Results for "${query}"`, style: "header" },
    { type: "divider" }
  ];

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
      text: "Open KokoBrain →" 
    });
    components.push({ type: "spacer", size: "s" });
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

app.listen(process.env.PORT || 3000, () => console.log('✅ KokoBrain debug search app running'));
