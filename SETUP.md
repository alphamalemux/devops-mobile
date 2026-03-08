# DevOps AI Platform — GitHub OAuth + PWA Setup Guide

## What You're Deploying

| File | Purpose |
|------|---------|
| `devops-platform.jsx` | Main app (React, 2534 lines) |
| `cf-worker.js` | Cloudflare Worker — OAuth proxy + webhook relay |
| `index.html` | PWA shell — loads + runs the JSX |
| `manifest.json` | PWA manifest (Add to Home Screen) |
| `sw.js` | Service worker — offline caching |

---

## Step 1 — Deploy the Cloudflare Worker

This is required before GitHub OAuth will work. It handles the OAuth token exchange (browser cannot do this directly — GitHub blocks CORS) and receives webhook events from GitHub.

### 1a. Create a free Cloudflare account
Go to https://cloudflare.com → Sign up (free tier is sufficient: 100k requests/day).

### 1b. Create a KV namespace
Workers & Pages → KV → Create namespace → Name it `EVENTS` → Save the ID.

### 1c. Deploy the worker (Dashboard method — no CLI needed)

1. Workers & Pages → Create → Create Worker
2. Paste the entire contents of `cf-worker.js` into the editor
3. Save & Deploy
4. **Copy your worker URL** — looks like: `https://devopsai-proxy.YOUR_NAME.workers.dev`

### 1d. Set environment variables
Worker → Settings → Variables → Add the following:

| Variable | Type | Value |
|----------|------|-------|
| `CLIENT_ID` | Plain text | Your GitHub OAuth App Client ID (set in Step 2) |
| `CLIENT_SECRET` | Secret | Your GitHub OAuth App Client Secret |
| `WEBHOOK_SECRET` | Secret | Any random string (e.g. output of `openssl rand -hex 20`) |

### 1e. Bind the KV namespace
Worker → Settings → KV Namespace Bindings → Add binding:
- Variable name: `EVENTS`
- KV Namespace: select `EVENTS` (created in 1b)

---

## Step 2 — Create a GitHub OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Fill in:
   - **Application name**: DevOps AI Platform
   - **Homepage URL**: your PWA URL (e.g. `https://devopsai.pages.dev`) — set this after Step 3, can update later
   - **Authorization callback URL**: **same as Homepage URL** (GitHub redirects back here after login)
3. Register application → **Copy the Client ID**
4. Generate a new client secret → **Copy it immediately** (shown once)
5. Paste Client ID into Cloudflare Worker env var `CLIENT_ID`
6. Paste Client Secret into Cloudflare Worker env var `CLIENT_SECRET` (as a Secret)

---

## Step 3 — Host the PWA

All 5 files (`index.html`, `devops-platform.jsx`, `manifest.json`, `sw.js`, and optionally `cf-worker.js` for reference) go in one folder.

### Option A — Cloudflare Pages (recommended, same account, 1 min)
1. Workers & Pages → Pages → Create → Upload assets
2. Drag your folder of 5 files
3. Deploy → you get `https://YOUR_PROJECT.pages.dev`
4. **Go back to GitHub OAuth App** → update Homepage URL and Callback URL to this URL

### Option B — Netlify Drop (30 seconds)
1. Go to https://app.netlify.com/drop
2. Drag the folder
3. Copy the `https://xxxxx.netlify.app` URL → update GitHub OAuth App callback URL

### Option C — GitHub Pages
1. Create a repo → push the 5 files
2. Settings → Pages → Deploy from branch (main, root)
3. URL: `https://USERNAME.github.io/REPO` → update GitHub OAuth App callback URL

---

## Step 4 — Configure the App

1. Open your PWA URL in Chrome on desktop or Android
2. Tap ⚙ Settings → GitHub OAuth tab
3. Enter:
   - **GitHub Client ID**: `Iv1.xxxxxxxxxxxxx` (from Step 2)
   - **Cloudflare Worker URL**: `https://devopsai-proxy.YOUR_NAME.workers.dev`
   - **Webhook Secret**: same random string you used in Step 1d
4. Go to the 🐙 GitHub tab → tap **Login with GitHub**
5. GitHub opens → Authorize → you're redirected back → logged in ✓

---

## Step 5 — Install as PWA on Android

1. Open the app URL in **Chrome for Android**
2. Chrome will show a banner: *"Add DevOpsAI to Home Screen"* — tap it
   - If no banner: tap ⋮ menu → Add to Home screen
3. Tap Add → the app appears in your app drawer
4. Open it — runs fullscreen, no browser chrome, like a native app

---

## Using Webhooks (Auto-Deploy on Push/PR)

Once logged in and in the GitHub tab:

1. Open a repo → tap **🔔 Add Webhook**
   - This calls the GitHub API to register your CF Worker as a webhook endpoint
   - GitHub will POST push/PR/deployment events to `https://YOUR_WORKER.workers.dev/webhook`
2. The app polls `/webhook/events` every 30 seconds for new events
3. In the repo detail view, configure **Auto-deploy**:
   - Toggle ON
   - Set branch (e.g. `main`)
   - Toggle on-push and/or on-PR-merge
4. When a push or merged PR matches your config, the app automatically triggers the deployment pipeline for the linked environment

---

## Troubleshooting

**"CF Worker URL not configured"** → Add it in ⚙ Settings → GitHub OAuth

**"OAuth state mismatch"** → Your browser blocked the redirect popup or you have third-party cookie blocking. Use redirect flow (default) not popup.

**"Token invalid or expired"** → Tap Sign out in the GitHub tab → log in again. OAuth tokens can expire; they're held in memory only and lost on page reload by design.

**Webhook events not arriving** → Check: (1) Worker is deployed, (2) KV binding is set, (3) GitHub repo Settings → Webhooks shows green checkmark for recent deliveries.

**"GitHub API rate limited"** → Authenticated requests get 5000/hour — you'd need to be hitting the API very hard to hit this.

**PWA won't install** → Must be served over HTTPS. Localhost counts as secure, but HTTP on a custom domain does not.

---

## Architecture Summary

```
Android Phone (Chrome PWA)
        │
        │  OAuth redirect
        ▼
github.com/login/oauth/authorize
        │
        │  ?code=xxx redirect back to PWA
        ▼
PWA → POST /oauth/token  ──→  Cloudflare Worker  ──→  github.com/login/oauth/access_token
                                     │                         │
                                     │  access_token           │
                                     ◄─────────────────────────┘
        │
        │  gho_ token stored in React state (memory only, cleared on reload)
        │
        │  Direct GitHub API calls (CORS allowed)
        ▼
api.github.com  (repos, branches, commits, file contents, webhook CRUD)

GitHub Events:
push / pull_request / deployment_status
        │
        ▼
Cloudflare Worker POST /webhook  →  KV store
        ▲
        │  GET /webhook/events (polling every 30s)
        │
PWA  ───┘  →  auto-deploy trigger if configured
```
