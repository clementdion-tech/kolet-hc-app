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
          placeholder: "e.g. eSIM activation, data not working, edge cases...",
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
    const articles = await searchKokoBrain(query);
    res.json({ canvas: buildResultsCanvas(query, articles) });
  } catch (err) {
    console.error(err);
    res.json({ canvas: buildErrorCanvas() });
  }
});

// Search your KokoBrain knowledge base
async function searchKokoBrain(query) {
  try {
    const q = query.toLowerCase();
    
    // Your KokoBrain articles - expand this list with your actual content
    const kokobrainArticles = [
      {
        title: "eSIM Activation Troubleshooting",
        url: "https://kokobrain.lovable.app/esim-activation",
        description: "Complete guide for resolving eSIM activation failures and edge cases",
        content: "esim activation data sim profile install troubleshoot failure edge cases ios android"
      },
      {
        title: "Data Connectivity Issues",
        url: "https://kokobrain.lovable.app/data-issues", 
        description: "Step-by-step resolution for when customer data is not working",
        content: "data not working connectivity roaming apn settings network connection mobile"
      },
      {
        title: "Referral System Guide",
        url: "https://kokobrain.lovable.app/referrals",
        description: "How the account referral system works and common issues",
        content: "referral account system credits bonus friend invite share reward"
      },
      {
        title: "Edge Cases Documentation",
        url: "https://kokobrain.lovable.app/edge-cases",
        description: "Handling unusual customer scenarios and edge cases",
        content: "edge cases unusual scenarios special situations exceptions handling guide"
      },
      {
        title: "Account Management Issues",
        url: "https://kokobrain.lovable.app/account-management",
        description: "Common account-related problems and solutions",
        content: "account management login password reset billing subscription cancel"
      },
      {
        title: "Installation Guide - Start Using Data",
        url: "https://kokobrain.lovable.app/installation",
        description: "How customers can install eSIM and start using their data plan",
        content: "install esim data plan setup configuration activate start using guide"
      }
    ];

    // Search through articles
    const results = kokobrainArticles.filter(article =>
      article.title.toLowerCase().includes(q) ||
      article.description.toLowerCase().includes(q) ||
      article.content.toLowerCase().includes(q)
    ).slice(0, 5);

    return results;
  } catch (error) {
    console.error('KokoBrain search failed:', error);
    return [];
  }
}

function buildResultsCanvas(query, articles) {
  const components = [
    { type: "text", text: `🧠 Results for "${query}"`, style: "header" },
    { type: "divider" }
  ];

  if (articles.length === 0) {
    components.push({
      type: "text",
      text: "No articles found in KokoBrain. Try different keywords.",
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

app.listen(process.env.PORT || 3000, () => console.log('✅ KokoBrain search app running'));
