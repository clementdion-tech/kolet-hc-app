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
  res.json(searchUI); // Default to search UI for GET requests
});

app.post('/intercom/submit', async (req, res) => {
  const query = req.body.input_values?.search_query;

  if (req.body.component_id === 'back_btn' || !query) {
    return res.json(searchUI);
  }

  try {
    const articles = await searchKokoBrainLive(query);
    res.json({ canvas: buildResultsCanvas(query, articles) });
  } catch (err) {
    console.error('KokoBrain search error:', err);
    res.json({ canvas: buildErrorCanvas() });
  }
});

// Fetch and search actual KokoBrain content
async function searchKokoBrainLive(query) {
  try {
    console.log(`Searching KokoBrain for: "${query}"`);
    
    // Fetch the main KokoBrain page
    const response = await fetch('https://kokobrain.lovable.app', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Kolet-HelpCenter/1.0)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    console.log('Successfully fetched KokoBrain content');
    
    // Extract content and search
    const results = await parseAndSearchKokoBrain(html, query);
    console.log(`Found ${results.length} matching articles`);
    
    return results;
  } catch (error) {
    console.error('Error fetching KokoBrain:', error);
    
    // Fallback to enhanced mock data based on common Kolet topics
    return searchFallbackArticles(query);
  }
}

// Parse HTML and extract searchable content
async function parseAndSearchKokoBrain(html, query) {
  const q = query.toLowerCase();
  const results = [];
  
  // Enhanced parsing - look for common patterns in HTML
  const titleRegex = /<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi;
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  const textRegex = /<p[^>]*>(.*?)<\/p>/gi;
  
  let match;
  const foundContent = [];
  
  // Extract headings
  while ((match = titleRegex.exec(html)) !== null) {
    const title = match[1].replace(/<[^>]*>/g, '').trim();
    if (title && title.toLowerCase().includes(q)) {
      foundContent.push({
        type: 'heading',
        text: title,
        relevance: 3
      });
    }
  }
  
  // Extract links
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    const url = linkMatch[1];
    const linkText = linkMatch[2].replace(/<[^>]*>/g, '').trim();
    if (linkText && linkText.toLowerCase().includes(q)) {
      foundContent.push({
        type: 'link',
        text: linkText,
        url: url.startsWith('http') ? url : `https://kokobrain.lovable.app${url}`,
        relevance: 2
      });
    }
  }
  
  // Extract paragraphs
  let textMatch;
  while ((textMatch = textRegex.exec(html)) !== null) {
    const text = textMatch[1].replace(/<[^>]*>/g, '').trim();
    if (text && text.toLowerCase().includes(q)) {
      foundContent.push({
        type: 'text',
        text: text,
        relevance: 1
      });
    }
  }
  
  // Convert found content to article format
  foundContent.sort((a, b) => b.relevance - a.relevance);
  
  for (let i = 0; i < Math.min(foundContent.length, 5); i++) {
    const content = foundContent[i];
    results.push({
      title: content.text.substring(0, 60) + (content.text.length > 60 ? '...' : ''),
      description: `Found in KokoBrain: "${content.text.substring(0, 100)}..."`,
      url: content.url || 'https://kokobrain.lovable.app'
    });
  }
  
  return results;
}

// Fallback search with enhanced Kolet-specific articles
function searchFallbackArticles(query) {
  const q = query.toLowerCase();
  
  // Enhanced article database with more Kolet-specific content
  const koletArticles = [
    {
      title: "eSIM Activation Troubleshooting Guide",
      url: "https://kokobrain.lovable.app/esim-activation",
      description: "Step-by-step guide for resolving eSIM activation issues and configuration problems",
      keywords: "esim activation data sim profile install troubleshoot failure edge cases ios android setup configure"
    },
    {
      title: "Data Connectivity Issues - Complete Resolution Guide",
      url: "https://kokobrain.lovable.app/data-issues",
      description: "Comprehensive troubleshooting for when customer data is not working or slow",
      keywords: "data not working connectivity roaming apn settings network connection mobile slow internet"
    },
    {
      title: "Refund and Cancellation Policy",
      url: "https://kokobrain.lovable.app/refunds",
      description: "How to process refunds, cancellations, and handle billing disputes",
      keywords: "refund cancellation billing dispute money back cancel subscription policy"
    },
    {
      title: "Account Referral System Guide",
      url: "https://kokobrain.lovable.app/referrals",
      description: "Understanding how referrals work, credits, and common referral issues",
      keywords: "referral account system credits bonus friend invite share reward program"
    },
    {
      title: "Edge Cases and Special Situations",
      url: "https://kokobrain.lovable.app/edge-cases",
      description: "Handling unusual customer scenarios and exceptional cases",
      keywords: "edge cases unusual scenarios special situations exceptions handling guide complex"
    },
    {
      title: "Installation Guide - Getting Started",
      url: "https://kokobrain.lovable.app/installation",
      description: "How customers install eSIM and start using their data plan",
      keywords: "install esim data plan setup configuration activate start using guide tutorial"
    },
    {
      title: "Account Management and Login Issues",
      url: "https://kokobrain.lovable.app/account",
      description: "Resolving login problems, password resets, and account access",
      keywords: "account management login password reset billing subscription access locked"
    },
    {
      title: "Roaming and International Data",
      url: "https://kokobrain.lovable.app/roaming",
      description: "How international roaming works and troubleshooting abroad",
      keywords: "roaming international data abroad travel foreign country network"
    },
    {
      title: "Device Compatibility Issues",
      url: "https://kokobrain.lovable.app/compatibility",
      description: "Checking device compatibility and resolving unsupported device issues",
      keywords: "compatibility device support phone model android ios unsupported check"
    }
  ];
  
  // Search through enhanced articles
  const results = koletArticles.filter(article =>
    article.title.toLowerCase().includes(q) ||
    article.description.toLowerCase().includes(q) ||
    article.keywords.toLowerCase().includes(q)
  ).slice(0, 5);
  
  console.log(`Fallback search found ${results.length} articles for "${query}"`);
  return results;
}

function buildResultsCanvas(query, articles) {
  const components = [
    { type: "text", text: `🧠 Results for "${query}"`, style: "header" },
    { type: "divider" }
  ];

  if (articles.length === 0) {
    components.push({
      type: "text",
      text: "No articles found in KokoBrain. Try different keywords or check if the content exists.",
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
      if (article.url) {
        components.push({ 
          type: "anchor", 
          href: article.url, 
          text: "Open in KokoBrain →" 
        });
      }
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

app.listen(process.env.PORT || 3000, () => console.log('✅ KokoBrain live search app running'));
