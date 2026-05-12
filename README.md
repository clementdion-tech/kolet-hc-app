# IKC Smart Search — KokoBrain

Intercom Canvas Kit app that surfaces relevant Notion knowledge base articles to support agents in real time. Combines BM25 search, context-aware ranking, and a click/vote learning loop.

---

## Stack

- **Runtime:** Node.js 24+
- **Framework:** Express 4
- **Knowledge base:** Notion API
- **Hosting:** Render (any Node-compatible host works)
- **Integration:** Intercom Canvas Kit v2

---

## Quick Start

```bash
git clone https://github.com/clementdion-tech/kolet-hc-app
cd kolet-hc-app
npm install
cp .env.example .env   # fill in your values
node server.js
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `INTERCOM_CLIENT_SECRET` | Yes (prod) | Canvas Kit client secret — verifies HMAC signatures on all incoming requests |
| `INTERCOM_ACCESS_TOKEN` | Yes | Intercom API token — used by the Refresh button to fetch live contact/conversation data |
| `NOTION_TOKEN` | Yes | Notion integration token |
| `NOTION_DATABASE_ID` | Yes | ID of the Notion database containing help articles |
| `DEBUG_TOKEN` | Optional | Protects all `/debug/*` endpoints |
| `APP_URL` | Optional | Base URL for article click-tracking links. Defaults to `https://kolet-hc-app.onrender.com` |
| `PORT` | Optional | Defaults to `3000` |
| `GSHEET_WEBHOOK_URL` | Optional | Google Apps Script web app URL for feedback tracking (removed — see notes) |

Create a `.env` file at the root:

```
INTERCOM_CLIENT_SECRET=your_canvas_kit_client_secret
INTERCOM_ACCESS_TOKEN=dG9r...
NOTION_TOKEN=ntn_...
NOTION_DATABASE_ID=abc123...
DEBUG_TOKEN=your-secret-debug-token
APP_URL=https://your-app.onrender.com
```

---

## Notion Database Schema

The app queries a Notion database. Each page must have:

| Property | Type | Usage |
|---|---|---|
| `Nom` | Title | Article title — highest-weight search field |
| `Day` | Select | Category — used for grouping and emoji mapping in the canvas |
| `Text` | Rich text | Manual keywords — second highest-weight search field |

Article body content is fetched recursively (blocks API) and used for full-text search at lower weight.

---

## Intercom Canvas Kit Setup

1. Go to **Intercom Developer Hub** → create or open your app
2. Under **Canvas Kit** → set:
   - **Initialize URL:** `https://your-app.com/intercom/initialize`
   - **Submit URL:** `https://your-app.com/intercom/submit`
3. Copy the **Client Secret** → `INTERCOM_CLIENT_SECRET`
4. Under **Basic Information** → copy the **Access Token** → `INTERCOM_ACCESS_TOKEN`

---

## Deploy to Render

1. Fork/push the repo to GitHub
2. Create a new **Web Service** on Render
3. Set **Build Command:** `npm install`
4. Set **Start Command:** `node server.js`
5. Add all environment variables from the table above
6. Deploy

**Free tier note:** The free tier spins down after 15 minutes of inactivity. The first request after spin-down fetches articles from Notion (warm-up). The app retries every 30s if Notion rate-limits on startup. Disk is ephemeral — `data/` files are wiped on each restart. Upgrade to a paid instance or add a Persistent Disk to preserve feedback and learned injection data across restarts.

---

## Deploy Anywhere Else

The app is a standard Express server with no platform-specific dependencies.

**Requirements:**
- Node.js 18+ (uses `globalThis.fetch`)
- Writable filesystem at `./data/` (for article cache, feedback, learned injections)
- Outbound HTTPS to `api.notion.com` and `api.intercom.io`
- Inbound HTTPS from Intercom (for Canvas Kit webhooks)

**Docker example:**

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
RUN mkdir -p data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Project Structure

```
kolet-hc-app/
├── server.js          # Everything — ~2500 lines (see refactor plan below)
├── package.json
├── .env               # Local env vars (never commit)
├── data/
│   ├── articles.json  # Article cache — rebuilt every 5 min from Notion
│   ├── feedback.json  # Vote scores — persisted on every vote (2s debounce)
│   └── learned.json   # Click-trained injections — persisted on every click
└── src/               # Module split (written, not yet wired in)
    ├── state.js        # Shared mutable state
    ├── nlp.js          # SYNONYMS, detectIntents, sanitizeQuery
    ├── search.js       # BM25 scoring, searchArticles
    └── canvas.js       # Canvas response builders
```

---

## How It Works

### Suggestion pipeline (`/intercom/initialize`)

```
1. Extract conversation text, inbox name, tags
2. Extract contact context: eSIM status, plan state, partner, device, loyalty...
3. BM25 search over Notion articles (IDF-weighted, field-boosted)
4. 6-step context re-ranking:
   - Hard inject: partner articles, fraud, compatibility, restricted country, Flying Blue, B2B
   - Intent detection (22 intents via regex, multilingual)
   - Intent-based article injection
   - eSIM-state fallback (never return empty)
   - Feedback multiplier (Laplace-smoothed from votes)
   - Learned injections (from agent click history)
5. Return canvas with 4 articles max (Canvas Kit component limit)
```

### Search (`/intercom/submit` with `search_btn`)

```
1. Pure BM25 scoring — no context boosts (query intent wins over contact context)
2. Top 5 results returned in a clean results canvas
3. Every article link routes through /track for click recording
4. Back button restores cached suggestions
```

### Learning loop

| Signal | Endpoint | Storage | Effect |
|---|---|---|---|
| 👍/👎 suggestion | `feedback_up_N` | `data/feedback.json` | Score multiplier for same context |
| 👍/👎 search result | `search_up_N` | `data/feedback.json` | Score multiplier for same query |
| Article click | `GET /track` | `data/learned.json` | Injects article in future suggestions for same contact type |

---

## API Endpoints

### Canvas Kit (called by Intercom)

```
GET  /intercom/initialize   Returns search-only canvas (no auth required)
POST /intercom/initialize   Returns suggestion canvas for a conversation
POST /intercom/submit       Handles all agent interactions
GET  /track                 Records article click, redirects to Notion
```

### Internal

```
GET  /health                { ok, cached, enriched }
```

### Debug (require ?token=DEBUG_TOKEN)

```
GET  /debug/contact-attrs   All raw contact custom_attributes from last init
GET  /debug/search?q=...    Live search scores for a query
GET  /debug/kb              All articles with keywords and enrichment status
GET  /debug/feedback        Vote log and per-article counts
GET  /debug/training        Feedback multipliers per article per context
GET  /debug/conv-cache      Last 50 conversation cache entries
GET  /debug/last-error      Last caught exception
```

---

## Contact Attributes Read from Intercom

The app reads these from `contact.custom_attributes`:

```
# eSIM
esim_status / latest_sparks_esim_status / latest_lanck_esim_status
esim_installation_count, esim_last_detected_country, esim_iccid
esim_is_one_click_installable, is_device_esim_compatible

# Device
device_brand, ios_device, ios_app_version, android_device, android_app_version

# Data plan
current_plan_consumed, current_plan_expires_at, current_plan_limit
current_plan_usage_started_at, current_plan_zone_code, current_plan_zone_label
initial_gift_zone_code, initial_gift_zone_label

# Partner / loyalty
initial_referrer_partner_slug, flying_blue_number

# Account
fraud_suspected, is_b2b, user_value, has_referred, language

# Wallet / Voucher / Donations (attribute names TBC — check /debug/contact-attrs)
wallet_koins / koin_balance, voucher_code / voucher_status, pending_data_donation

# Contact tags
contact.tags.data[]
```

> To find the exact attribute names your Intercom setup uses for Wallet, Voucher, and Data donation panels: open any conversation, then hit `/debug/contact-attrs?token=DEBUG_TOKEN`. Update `extractContactContext()` with the correct names.

---

## Disk Files

| File | Purpose | Lost on restart? |
|---|---|---|
| `data/articles.json` | Article cache for instant cold starts | Yes (rebuilt in <30s) |
| `data/feedback.json` | Vote-based training scores | Yes ⚠️ |
| `data/learned.json` | Click-based learned injections | Yes ⚠️ |

To preserve feedback data across restarts: add a Persistent Disk on Render, or export and re-upload `data/feedback.json` and `data/learned.json` manually before redeploying.

---

## Refactor Plan (not yet executed)

The current `server.js` is ~2500 lines. The `src/` modules have been written (state, nlp, search, canvas) but not yet wired into `server.js`. When ready to split:

1. `require('./src/state')` — replaces all module-level mutable state
2. `require('./src/nlp')` — SYNONYMS, detectIntents, sanitizeQuery, buildContextFingerprint
3. `require('./src/search')` — BM25 scoring, searchArticles, computeQueryIDF
4. `require('./src/canvas')` — buildSuggestionsCanvas, buildResultsCanvas, etc.

Multi-instance scaling (2+ Render dynos) requires moving all in-memory caches to Redis:
- `convSuggestionsCache` + `convSearchCache` → Redis with TTL
- `articleFeedbackScores` + `feedbackLog` → Redis hash or Postgres
- `learnedInjections` → Redis hash

---

## Known Issues / Limitations

- **Single instance only** — all state is in-memory. Multi-instance requires Redis.
- **Ephemeral disk on Render free tier** — feedback and learned data resets on restart.
- **Canvas Kit component limit** — ~30 components max. Suggestions capped at 4 articles.
- **English-only search** — BM25 tokeniser uses `\w` (ASCII). Agent queries expected in English.
- **Notion rate limits** — 3 req/s. Warm-up retries every 30s on rate limit failure.
- **Render free tier cold start** — 50s spin-up delay on first request after inactivity. Mitigate by pinging `/health` every 10 minutes with an uptime monitor (UptimeRobot free tier).
