import { useState, useEffect, useRef, useCallback, useReducer } from "react";

// ─────────────────────────────────────────────────────────────
// BREAKPOINT HOOK
// phone  : < 600px  → bottom tabs, single column, slide sheets
// fold   : 600–1023 → split pane side-by-side (foldable open)
// wide   : ≥ 1024   → desktop sidebar layout
// ─────────────────────────────────────────────────────────────
function useBreakpoint() {
  const getSize = () => {
    const w = window.innerWidth;
    if (w < 600)  return "phone";
    if (w < 1024) return "fold";
    return "wide";
  };
  const [bp, setBp] = useState(getSize);
  useEffect(() => {
    const handler = () => setBp(getSize());
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return bp;
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const AI_BACKENDS = {
  claude: {
    id: "claude", label: "Claude", shortLabel: "CLO",
    color: "#D97706", endpoint: "https://api.anthropic.com/v1/messages",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    note: "HTTP proxy — no API key required",
  },
  ollama: {
    id: "ollama", label: "Ollama", shortLabel: "OLL",
    color: "#10B981", endpoint: "http://localhost:11434/api/chat",
    models: ["llama3.2", "codellama", "mistral", "deepseek-coder", "gemma2"],
    note: "Requires: ollama serve (symlink /usr/local/bin/ollama)",
  },
  openrouter: {
    id: "openrouter", label: "OpenRouter", shortLabel: "OPR",
    color: "#8B5CF6", endpoint: "https://openrouter.ai/api/v1/chat/completions",
    models: [
      "meta-llama/llama-3.1-8b-instruct:free",
      "mistralai/mistral-7b-instruct:free",
      "google/gemma-2-9b-it:free",
      "deepseek/deepseek-coder",
      "anthropic/claude-3-haiku",
    ],
    note: "Requires OpenRouter API key",
  },
};

const ENV_TYPES = {
  docker:  { icon: "🐳", color: "#0EA5E9", label: "Docker",   desc: "Container image & runtime" },
  android: { icon: "🤖", color: "#3DDC84", label: "Android",  desc: "APK / AAB via Gradle" },
  rust:    { icon: "🦀", color: "#F75208", label: "Rust",     desc: "Cargo toolchain & targets" },
  python:  { icon: "🐍", color: "#EAB308", label: "Python",   desc: "venv + pip + WSGI server" },
  nodejs:  { icon: "⬡",  color: "#84CC16", label: "Node.js",  desc: "npm + build + PM2" },
  compose: { icon: "🔧", color: "#F97316", label: "Compose",  desc: "Multi-service stack" },
  static:  { icon: "⚡", color: "#EC4899", label: "Static",   desc: "nginx/caddy build+serve" },
};

const STATUS_MAP = {
  running:   { color: "#22c55e", bg: "#052e16", label: "RUNNING",   pulse: true },
  idle:      { color: "#64748b", bg: "#0f172a", label: "IDLE",      pulse: false },
  building:  { color: "#f59e0b", bg: "#1c1400", label: "BUILDING",  pulse: true },
  deploying: { color: "#a855f7", bg: "#1a0e2e", label: "DEPLOYING", pulse: true },
  stopped:   { color: "#ef4444", bg: "#1c0a0a", label: "STOPPED",   pulse: false },
  error:     { color: "#ef4444", bg: "#1c0a0a", label: "ERROR",     pulse: false },
};

const BOTTOM_TABS = [
  { id: "chat",     label: "Chat",    icon: "💬" },
  { id: "envs",     label: "Envs",    icon: "▦"  },
  { id: "github",   label: "GitHub",  icon: "🐙" },
  { id: "terminal", label: "Logs",    icon: "⌨"  },
  { id: "settings", label: "Config",  icon: "⚙"  },
];

// ─────────────────────────────────────────────────────────────
// GITHUB OAUTH + API LAYER
//
// Auth strategy: GitHub OAuth App via Cloudflare Worker proxy.
// Why: Browser cannot exchange code→token directly (GitHub CORS
// blocks it). The CF Worker (cf-worker.js) does the exchange
// server-side and returns the access_token to the PWA.
//
// Flow:
//   1. User clicks "Login with GitHub"
//   2. App redirects to github.com/login/oauth/authorize
//   3. GitHub redirects back to PWA with ?code=...&state=...
//   4. App POSTs code to CF Worker /oauth/token
//   5. Worker exchanges code for gho_ token, returns it
//   6. Token kept in memory only — never persisted to disk
//
// Webhooks: GitHub POSTs push/PR events to CF Worker /webhook.
// Worker stores in KV. PWA polls /webhook/events every 30s.
// ─────────────────────────────────────────────────────────────
const GH_API      = "https://api.github.com";
const GH_AUTH_URL = "https://github.com/login/oauth/authorize";

// CF Worker URL — user fills this in Settings after deploying worker
// Falls back gracefully when not configured.
const getCFWorkerUrl = (settings) => settings?.cfWorkerUrl?.replace(/\/$/, "") ?? "";

// ── CSRF state nonce ─────────────────────────────────────────
function generateOAuthState() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

// ── Build the GitHub authorization redirect URL ──────────────
function buildOAuthRedirectURL(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id:    clientId,
    redirect_uri: redirectUri,
    scope:        "repo read:user",
    state,
    allow_signup: "true",
  });
  return `${GH_AUTH_URL}?${params.toString()}`;
}

// ── Parse ?code & ?state from the redirect callback ──────────
function parseOAuthCallback(search) {
  const p = new URLSearchParams(search);
  const code  = p.get("code");
  const state = p.get("state");
  const error = p.get("error");
  if (error) return { ok: false, error: p.get("error_description") ?? error };
  if (!code || !state) return { ok: false, error: "missing_code_or_state" };
  return { ok: true, code, state };
}

// ── Exchange code for access_token via CF Worker ─────────────
async function exchangeCodeForToken(workerUrl, code, redirectUri) {
  if (!workerUrl) throw new Error("CF Worker URL not configured — add it in ⚙ Settings → GitHub");
  const res = await fetch(`${workerUrl}/oauth/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `Worker ${res.status}`);
  if (!data.access_token) throw new Error("No token returned from worker");
  return data; // { access_token, scope, token_type }
}

// ── Validate token format (gho_ = OAuth, ghp_ = classic PAT) ─
function validateGHToken(token) {
  return /^(gho_|ghp_|github_pat_)[A-Za-z0-9_]{10,}$/.test(token?.trim() ?? "");
}

// ── Core GitHub API fetch ─────────────────────────────────────
async function ghFetch(token, path, options = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Error("Token invalid or expired — please reconnect GitHub");
  if (res.status === 403) throw new Error("GitHub API rate limited. Wait 60s and retry.");
  if (res.status === 404) throw new Error(`Not found: ${path}`);
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${path}`);
  return res.json();
}

const ghFetchUser      = (t) => ghFetch(t, "/user");
const ghFetchRepos     = (t) => ghFetch(t, "/user/repos?sort=updated&per_page=50&type=all");
const ghFetchBranches  = (t, full) => ghFetch(t, `/repos/${full}/branches?per_page=30`);
const ghFetchCommits   = (t, full, br) => ghFetch(t, `/repos/${full}/commits?sha=${br}&per_page=20`);
const ghFetchTree      = (t, full, br) => ghFetch(t, `/repos/${full}/git/trees/${br}?recursive=1`);

async function ghFetchFileContent(token, fullName, filePath, branch) {
  const data = await ghFetch(token, `/repos/${fullName}/contents/${filePath}?ref=${branch}`);
  if (data.encoding === "base64") return atob(data.content.replace(/\n/g, ""));
  throw new Error("Unexpected file encoding: " + data.encoding);
}

// ── Create / delete GitHub webhook pointing at CF Worker ──────
async function ghCreateWebhook(token, fullName, workerUrl, secret) {
  return ghFetch(token, `/repos/${fullName}/hooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name:   "web",
      active: true,
      events: ["push", "pull_request", "deployment_status"],
      config: {
        url:          `${workerUrl}/webhook`,
        content_type: "json",
        secret:       secret ?? "",
        insecure_ssl: "0",
      },
    }),
  });
}

async function ghDeleteWebhook(token, fullName, hookId) {
  const res = await fetch(`${GH_API}/repos/${fullName}/hooks/${hookId}`, {
    method:  "DELETE",
    headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Delete webhook: ${res.status}`);
  return true;
}

// ── Poll CF Worker for new webhook events ─────────────────────
async function pollWebhookEvents(workerUrl, repoFullName, since) {
  if (!workerUrl || !repoFullName) return [];
  const url = `${workerUrl}/webhook/events?repo=${encodeURIComponent(repoFullName)}&since=${since}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.events ?? [];
}

// ── Process raw webhook event into a display-friendly shape ───
function processWebhookEvent(raw) {
  const s = raw.summary ?? {};
  if (s.event === "push") {
    return { ...s, label: `⬆ Push to ${s.branch}`, detail: s.message, color: "#60a5fa" };
  }
  if (s.event === "pull_request") {
    const icon = s.merged ? "🔀" : s.action === "opened" ? "🟢" : "🔴";
    return { ...s, label: `${icon} PR #${s.number}: ${s.title}`, detail: `${s.action}${s.merged ? " & merged" : ""}`, color: "#a78bfa" };
  }
  if (s.event === "deployment_status") {
    const icon = s.state === "success" ? "✓" : s.state === "failure" ? "✗" : "⟳";
    return { ...s, label: `${icon} Deploy: ${s.state}`, detail: s.description, color: s.state === "success" ? "#4ade80" : "#f87171" };
  }
  return { ...s, label: `⚡ ${s.event}`, detail: "", color: "#94a3b8" };
}

// ── Auto-deploy trigger ────────────────────────────────────────
function shouldAutoDeploy(processedEvent, autoDeploy) {
  if (!autoDeploy?.enabled) return false;
  if (processedEvent.event === "push" && autoDeploy.onPush) {
    return processedEvent.branch === (autoDeploy.branch ?? "main");
  }
  if (processedEvent.event === "pull_request" && autoDeploy.onMerge) {
    return processedEvent.action === "closed" && processedEvent.merged === true;
  }
  return false;
}

// ── Detect env type from GitHub repo language ─────────────────
function detectEnvType(language) {
  const l = (language ?? "").toLowerCase();
  const map = { rust:"rust", python:"python", kotlin:"android", java:"android", javascript:"nodejs", typescript:"nodejs", html:"static", css:"static" };
  return map[l] ?? "docker";
}

// ─────────────────────────────────────────────────────────────
// DEPLOYMENT SCRIPTS
// ─────────────────────────────────────────────────────────────
const DEPLOY_SCRIPTS = {
  docker: (name, port = 3000) => [
    `$ docker build -t ${name}:latest --no-cache .`,
    `  [1/5] FROM node:20-alpine sha256:a1b2...`,
    `  [2/5] COPY package*.json ./`,
    `  [3/5] RUN npm ci --production`,
    `       Added 847 packages in 11.4s`,
    `  [4/5] COPY . .`,
    `  [5/5] EXPOSE ${port}`,
    `✓ Built ${name}:latest (12.3s)`,
    `$ docker run -d --name ${name} --restart unless-stopped -p ${port}:${port} ${name}:latest`,
    `  Container ID: a4f8c2e1d9b3...`,
    `$ docker inspect --format='{{.State.Health.Status}}' ${name}`,
    `  healthy`,
    `✓ ${name} live → http://localhost:${port}`,
  ],
  android: (name) => [
    `$ cd ${name}/ && ls`,
    `  build.gradle  app/  gradle/  gradlew`,
    `$ ./gradlew clean`,
    `  > Task :clean UP-TO-DATE`,
    `$ ./gradlew assembleRelease --stacktrace`,
    `  > Task :app:preBuild`,
    `  > Task :app:dexBuilderRelease`,
    `  > Task :app:packageRelease`,
    `  > Task :app:assembleRelease`,
    `  BUILD SUCCESSFUL in 2m 14s`,
    `  32 actionable tasks: 32 executed`,
    `$ ls -lh app/build/outputs/apk/release/`,
    `  app-release.apk  (14.2 MB)`,
    `$ apksigner verify app/build/outputs/apk/release/app-release.apk`,
    `  Verified using v2 scheme (APK Signature Scheme v2)`,
    `✓ APK signed → app/build/outputs/apk/release/app-release.apk`,
  ],
  rust: (name, target = "x86_64-unknown-linux-gnu") => [
    `$ rustup show`,
    `  rustc 1.82.0 (f6e511eec 2024-10-15)`,
    `$ rustup target add ${target}`,
    `  info: component 'rust-std' for '${target}' is up to date`,
    `$ cargo fetch`,
    `  Updating crates.io index`,
    `  Fetching 47 packages...`,
    `$ cargo build --release --target ${target}`,
    `  Compiling tokio v1.41.0`,
    `  Compiling ${name} v0.1.0`,
    `    Finished \`release\` profile in 43.2s`,
    `$ strip target/${target}/release/${name}`,
    `$ ls -lh target/${target}/release/${name}`,
    `  -rwxr-xr-x  8.4M  ${name}`,
    `✓ Binary → target/${target}/release/${name}`,
  ],
  python: (name, port = 5000) => [
    `$ cd ${name}/`,
    `$ python3 -m venv .venv && source .venv/bin/activate`,
    `(.venv) $ pip install -r requirements.txt -q`,
    `  Successfully installed flask gunicorn psycopg2-binary`,
    `(.venv) $ python -m pytest tests/ -q`,
    `  6 passed in 0.84s`,
    `(.venv) $ gunicorn app:app -w 4 -b 0.0.0.0:${port} --daemon`,
    `  [INFO] Arbiter booted`,
    `  [INFO] Worker pid 12847 booted`,
    `  [INFO] Worker pid 12848 booted`,
    `$ curl -s http://localhost:${port}/health`,
    `  {"status":"healthy","workers":4}`,
    `✓ ${name} serving on :${port} (4 workers)`,
  ],
  nodejs: (name, port = 3000) => [
    `$ cd ${name}/ && node --version`,
    `  v20.17.0`,
    `$ npm ci`,
    `  added 847 packages in 11.4s`,
    `$ npm run build`,
    `  ✓ 1247 modules transformed`,
    `  dist/assets/index.js  142.48 kB`,
    `  ✓ built in 3.42s`,
    `$ NODE_ENV=production node dist/server.js &`,
    `  [${name}] listening on port ${port}`,
    `$ curl -sf http://localhost:${port}/ping`,
    `  {"pong":true}`,
    `✓ ${name} running → http://localhost:${port}`,
  ],
  compose: (name) => [
    `$ cd ${name}/ && docker-compose config --quiet`,
    `  ✓ Compose file valid`,
    `$ docker-compose pull`,
    `  Pulling postgres  ... done`,
    `  Pulling redis     ... done`,
    `  Pulling api       ... done`,
    `$ docker-compose up -d --remove-orphans`,
    `  Creating network "${name}_default"`,
    `  Creating ${name}_postgres_1 ... done`,
    `  Creating ${name}_redis_1    ... done`,
    `  Creating ${name}_api_1      ... done`,
    `$ docker-compose exec api wget -qO- localhost:3000/health`,
    `  {"status":"ok","db":"connected","cache":"connected"}`,
    `✓ Stack ${name} healthy (3 services)`,
  ],
  static: (name) => [
    `$ cd ${name}/ && npm ci -q`,
    `$ npm run build`,
    `  ✓ vite build done in 892ms`,
    `  dist/index.html  0.41 kB`,
    `  dist/assets/     67.48 kB`,
    `$ rsync -av --delete dist/ /var/www/${name}/`,
    `  index.html  assets/`,
    `  sent 69,403 bytes`,
    `$ nginx -t && nginx -s reload`,
    `  nginx: configuration test is successful`,
    `  ✓ nginx reloaded`,
    `✓ ${name} live → https://${name}.local`,
  ],
};

// ─────────────────────────────────────────────────────────────
// INTENT PARSER
// ─────────────────────────────────────────────────────────────
const INTENT_RULES = [
  { re: /\bdeploy\b|\blaunch\b|\bstart\b/i,             action: "DEPLOY" },
  { re: /\bbuild\b|\bcompile\b|\bassemble\b/i,           action: "BUILD"  },
  { re: /\bstop\b|\bkill\b|\bshutdown\b|\bdown\b/i,     action: "STOP"   },
  { re: /\blogs?\b|\boutput\b|\btail\b/i,                action: "LOGS"   },
  { re: /\bstatus\b|\bhealth\b|\bcheck\b/i,              action: "STATUS" },
  { re: /\bsetup\b|\binstall\b|\binit\b|\bbootstrap\b/i, action: "SETUP"  },
  { re: /\bconfig\b|\bdockerfile\b|\bgenerate\b/i,       action: "CONFIG" },
  { re: /\bdebug\b|\bfix\b|\btroubleshoot\b/i,           action: "DEBUG"  },
  { re: /\blist\b|\bshow\b|\benvs?\b|\benvironments?\b/i,action: "LIST"   },
];

const ENV_RULES = [
  { re: /\bdocker\b|\bcontainer\b|\bimage\b/i,                    type: "docker"  },
  { re: /\bandroid\b|\bapk\b|\baab\b|\bgradle\b|\bmobile\b/i,     type: "android" },
  { re: /\brust\b|\bcargo\b|\bcrate\b/i,                          type: "rust"    },
  { re: /\bpython\b|\bpip\b|\bflask\b|\bfastapi\b|\bdjango\b/i,   type: "python"  },
  { re: /\bnode\b|\bnpm\b|\breact\b|\bnext\b|\bvite\b/i,          type: "nodejs"  },
  { re: /\bcompose\b|\bstack\b|\bmulti.?service\b/i,              type: "compose" },
  { re: /\bstatic\b|\bhtml\b|\bnginx\b|\bcaddy\b/i,               type: "static"  },
];

function parseIntent(text) {
  return {
    action:     INTENT_RULES.find(r => r.re.test(text))?.action ?? "CHAT",
    envType:    ENV_RULES.find(r => r.re.test(text))?.type ?? null,
    envName:    text.match(/(?:named?|called?|for)\s+["']?([a-z0-9_-]+)["']?/i)?.[1] ?? null,
    port:       text.match(/(?:port|:)\s*(\d{3,5})/i)?.[1] ? parseInt(text.match(/(?:port|:)\s*(\d{3,5})/i)[1]) : null,
    rustTarget: text.match(/([a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+)/i)?.[1] ?? "x86_64-unknown-linux-gnu",
  };
}

// ─────────────────────────────────────────────────────────────
// AI ROUTER
// ─────────────────────────────────────────────────────────────
const SYS_PROMPT = `You are DevOpsAI — an expert deployment automation assistant.
You manage: Docker, Android (APK/AAB via Gradle), Rust toolchain (cargo + cross-compile), Python (venv + gunicorn/uvicorn), Node.js (npm + PM2), Compose stacks, Static sites (nginx/caddy).
Connected to: Claude (HTTP artifact proxy), Ollama (local symlink), OpenRouter (Bearer token).

Rules:
1. When user wants to DEPLOY/BUILD/SETUP — give a brief explanation then output EXACTLY:
<<<ACTION_PROPOSAL>>>{"action":"DEPLOY","envType":"docker","envName":"my-app","port":3000}<<<END_ACTION_PROPOSAL>>>
2. For LIST requests — output: <<<ENV_LIST>>>{}<<<END_ENV_LIST>>>
3. For configs — use fenced code blocks with language tag
4. Keep responses concise and technical. No filler words.
5. Android: include Gradle wrapper commands, APK signing hints
6. Rust: mention rustup target management, cross-compilation, strip binary
7. Python: cover venv isolation, requirements pinning, process supervisors`;

async function callAI(backendId, model, history, apiKey, onStream) {
  const msgs = history
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role, content: m.rawText ?? m.content ?? "" }))
    .filter(m => m.content.length > 0);

  if (backendId === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || "claude-sonnet-4-20250514", max_tokens: 1500, system: SYS_PROMPT, messages: msgs }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 160)}`);
    const data = await res.json();
    const text = data.content?.find(b => b.type === "text")?.text ?? "";
    onStream(text);
    return text;
  }

  if (backendId === "ollama") {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || "llama3.2", stream: true, messages: [{ role: "system", content: SYS_PROMPT }, ...msgs] }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status} — is 'ollama serve' running?`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n").filter(Boolean)) {
        try { const j = JSON.parse(line); if (j.message?.content) { full += j.message.content; onStream(full); } } catch {}
      }
    }
    return full;
  }

  if (backendId === "openrouter") {
    if (!apiKey?.trim()) throw new Error("OpenRouter API key required — set it in ⚙ Settings");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://devopsai.platform",
        "X-Title": "DevOps AI Platform",
      },
      body: JSON.stringify({ model: model || "meta-llama/llama-3.1-8b-instruct:free", stream: false, messages: [{ role: "system", content: SYS_PROMPT }, ...msgs] }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 160)}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    onStream(text);
    return text;
  }

  throw new Error(`Unknown backend: ${backendId}`);
}

// ─────────────────────────────────────────────────────────────
// PARSE AI RESPONSE → BLOCKS
// ─────────────────────────────────────────────────────────────
function parseAIResponse(raw) {
  const blocks = [];
  let remaining = raw;

  const apRe = /<<<ACTION_PROPOSAL>>>([\s\S]*?)<<<END_ACTION_PROPOSAL>>>/g;
  let m;
  while ((m = apRe.exec(raw)) !== null) {
    try { blocks.push({ type: "action_proposal", proposal: JSON.parse(m[1].trim()), id: `ap-${Date.now()}-${Math.random().toString(36).slice(2)}` }); }
    catch {}
    remaining = remaining.replace(m[0], "").trim();
  }

  if (/<<<ENV_LIST>>>/.test(raw)) {
    blocks.push({ type: "env_list_request" });
    remaining = remaining.replace(/<<<ENV_LIST>>>[\s\S]*?<<<END_ENV_LIST>>>/g, "").trim();
  }

  if (remaining) blocks.push({ type: "text", content: remaining });
  return blocks.length ? blocks : [{ type: "text", content: raw }];
}

// ─────────────────────────────────────────────────────────────
// ENVIRONMENTS REDUCER
// ─────────────────────────────────────────────────────────────
const INITIAL_ENVS = [
  { id: "e1", name: "api-gateway",    type: "docker",  status: "running",  port: 3000, branch: "main",    health: 99, lastDeploy: "2h ago",  logs: ["✓ Container running :3000", "[INFO] Health: ok"] },
  { id: "e2", name: "android-client", type: "android", status: "idle",     port: null, branch: "release", health: 0,  lastDeploy: "1d ago",  logs: ["✓ app-release.apk (14.2 MB)"] },
  { id: "e3", name: "ml-inference",   type: "rust",    status: "idle",     port: null, branch: "main",    health: 0,  lastDeploy: "3d ago",  logs: ["✓ Binary: target/release/ml-inference"] },
  { id: "e4", name: "data-pipeline",  type: "python",  status: "running",  port: 5000, branch: "develop", health: 92, lastDeploy: "6h ago",  logs: ["✓ gunicorn workers: 4", "[INFO] :5000"] },
  { id: "e5", name: "web-frontend",   type: "static",  status: "running",  port: 8080, branch: "main",    health: 100,lastDeploy: "1h ago",  logs: ["✓ nginx :8080"] },
  { id: "e6", name: "infra-stack",    type: "compose", status: "stopped",  port: null, branch: "staging", health: 0,  lastDeploy: "2d ago",  logs: ["[INFO] Stack stopped cleanly"] },
];

function envsReducer(state, action) {
  switch (action.type) {
    case "ADD":    return [...state, action.env];
    case "UPDATE": return state.map(e => e.id === action.id ? { ...e, ...action.patch } : e);
    case "LOG":    return state.map(e => e.id === action.id ? { ...e, logs: [...e.logs, action.line] } : e);
    default:       return state;
  }
}

// ─────────────────────────────────────────────────────────────
// DEPLOYMENT RUNNER
// ─────────────────────────────────────────────────────────────
function runDeployment(env, dispatch, onLog, onDone) {
  const scriptFn = DEPLOY_SCRIPTS[env.type] ?? DEPLOY_SCRIPTS.docker;
  const lines = scriptFn(env.name, env.port ?? 3000);
  dispatch({ type: "UPDATE", id: env.id, patch: { status: "deploying", health: 0, lastDeploy: "running…" } });
  let i = 0;
  const iv = setInterval(() => {
    if (i < lines.length) {
      const line = `[${new Date().toLocaleTimeString()}] ${lines[i++]}`;
      dispatch({ type: "LOG", id: env.id, line });
      onLog(line);
    } else {
      clearInterval(iv);
      dispatch({ type: "UPDATE", id: env.id, patch: { status: "running", health: 99, lastDeploy: "just now" } });
      onDone();
    }
  }, 260);
  return () => clearInterval(iv);
}

// ─────────────────────────────────────────────────────────────
// ATOMS
// ─────────────────────────────────────────────────────────────
function StatusDot({ status, size = 8 }) {
  const s = STATUS_MAP[status] ?? STATUS_MAP.idle;
  return (
    <span style={{
      display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: s.color, flexShrink: 0,
      boxShadow: s.pulse ? `0 0 ${size + 2}px ${s.color}` : "none",
      animation: s.pulse ? "gpulse 1.4s ease-in-out infinite" : "none",
    }} />
  );
}

function Tag({ children, color = "#64748b" }) {
  return (
    <span style={{
      padding: "1px 6px", borderRadius: 3, fontSize: 10, letterSpacing: 0.8,
      fontFamily: "monospace", color, background: `${color}18`, border: `1px solid ${color}28`,
      flexShrink: 0,
    }}>{children}</span>
  );
}

// Touch-friendly button: min 44px height
function TBtn({ children, variant = "ghost", onClick, disabled, full, small, style: extra }) {
  const V = {
    primary: { bg: "#1d4ed8", color: "#fff",   border: "#3b82f6" },
    success: { bg: "#14532d", color: "#4ade80", border: "#16a34a" },
    danger:  { bg: "#450a0a", color: "#f87171", border: "#dc2626" },
    ghost:   { bg: "#0f172a", color: "#94a3b8", border: "#1e293b" },
    outline: { bg: "transparent", color: "#64748b", border: "#1e293b" },
    active:  { bg: "#1e3a5f", color: "#60a5fa", border: "#2563eb" },
  }[variant] ?? {};
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: small ? 36 : 44,
        padding: small ? "6px 14px" : "10px 18px",
        borderRadius: 10, fontSize: small ? 12 : 14,
        cursor: disabled ? "not-allowed" : "pointer",
        background: V.bg, color: V.color, border: `1px solid ${V.border}`,
        fontFamily: "inherit", opacity: disabled ? 0.45 : 1,
        width: full ? "100%" : undefined,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        transition: "opacity 0.15s",
        WebkitTapHighlightColor: "transparent",
        userSelect: "none",
        ...extra,
      }}
    >{children}</button>
  );
}

// ─────────────────────────────────────────────────────────────
// TERMINAL BLOCK  (horizontal scroll on mobile)
// ─────────────────────────────────────────────────────────────
function TerminalBlock({ lines, height = 200, title }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);

  const lineColor = l => {
    if (l.includes("✓")) return "#4ade80";
    if (l.match(/\]\s+\$/) || l.startsWith("$ ")) return "#60a5fa";
    if (l.includes("ERROR") || l.includes("FAILED")) return "#f87171";
    if (l.includes("WARN") || l.includes("warn")) return "#fbbf24";
    if (l.includes("=>") || l.match(/\[[\d/]+\]/)) return "#7dd3fc";
    if (l.includes("INFO")) return "#94a3b8";
    return "#cbd5e1";
  };

  return (
    <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #0f172a" }}>
      {title && (
        <div style={{
          background: "#050a0f", padding: "6px 12px",
          display: "flex", alignItems: "center", gap: 6,
          borderBottom: "1px solid #0f172a",
        }}>
          {["#ef4444","#f59e0b","#22c55e"].map(c => (
            <span key={c} style={{ width: 8, height: 8, borderRadius: "50%", background: c, display: "inline-block" }} />
          ))}
          <span style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", letterSpacing: 0.5, marginLeft: 4 }}>{title}</span>
        </div>
      )}
      <div ref={ref} style={{
        background: "#020408", padding: "10px 12px", height, overflowY: "auto", overflowX: "auto",
        fontFamily: "'Fira Code','Cascadia Code','JetBrains Mono',monospace",
        fontSize: 11, lineHeight: 1.8,
        WebkitOverflowScrolling: "touch",
      }}>
        {lines.map((l, i) => (
          <div key={i} style={{ color: lineColor(l), whiteSpace: "pre", wordBreak: "normal", minWidth: "max-content" }}>
            {l}
          </div>
        ))}
        <span style={{
          display: "inline-block", width: 7, height: 12,
          background: "#60a5fa50", animation: "blink 1s step-end infinite", verticalAlign: "middle",
        }} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RICH TEXT RENDERER
// ─────────────────────────────────────────────────────────────
function RichText({ text, streaming }) {
  const segs = text.split(/(```[\w]*\n[\s\S]*?```)/g);
  return (
    <div style={{ fontSize: 14, lineHeight: 1.72, color: "#d1d5db" }}>
      {segs.map((seg, i) => {
        if (seg.startsWith("```")) {
          const lines = seg.split("\n");
          const lang = lines[0].replace("```", "").trim() || "sh";
          const code = lines.slice(1).join("\n").replace(/```$/, "").trimEnd();
          return (
            <div key={i} style={{ borderRadius: 8, margin: "10px 0", overflow: "hidden", border: "1px solid #1e293b" }}>
              <div style={{ padding: "4px 12px", background: "#0a0f1a", borderBottom: "1px solid #0f172a", fontSize: 9, color: "#475569", fontFamily: "monospace", letterSpacing: 1 }}>
                {lang.toUpperCase()}
              </div>
              <pre style={{ margin: 0, padding: "12px 12px", background: "#020408", color: "#7dd3fc", fontSize: 11, fontFamily: "monospace", lineHeight: 1.65, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                {code}
              </pre>
            </div>
          );
        }
        const parts = seg.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        return (
          <span key={i}>
            {parts.map((p, j) => {
              if (p.startsWith("**") && p.endsWith("**")) return <strong key={j} style={{ color: "#f1f5f9", fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
              if (p.startsWith("`") && p.endsWith("`")) return <code key={j} style={{ background: "#0f172a", color: "#7dd3fc", padding: "1px 5px", borderRadius: 3, fontSize: 12, fontFamily: "monospace" }}>{p.slice(1, -1)}</code>;
              return p.split("\n").flatMap((line, k) => k === 0 ? [line] : [<br key={k} />, line]);
            })}
            {streaming && i === segs.length - 1 && (
              <span style={{ display: "inline-block", width: 6, height: 13, background: "#60a5fa", animation: "blink 0.7s step-end infinite", verticalAlign: "middle", marginLeft: 2 }} />
            )}
          </span>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ACTION PROPOSAL CARD
// ─────────────────────────────────────────────────────────────
function ActionProposalCard({ proposal, onConfirm, onDismiss, confirmed, executing, done }) {
  const t = ENV_TYPES[proposal.envType] ?? ENV_TYPES.docker;
  const aColor = { DEPLOY:"#22c55e", BUILD:"#3b82f6", SETUP:"#f59e0b", CONFIG:"#8b5cf6", STOP:"#ef4444", DEBUG:"#f97316" }[proposal.action] ?? "#60a5fa";

  return (
    <div style={{ background: "#050a0f", border: `1px solid ${aColor}35`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", background: `${aColor}0d`, borderBottom: `1px solid ${aColor}20`, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>{t.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
            <Tag color={aColor}>{proposal.action}</Tag>
            <span style={{ fontFamily: "monospace", fontSize: 14, color: "#f1f5f9", fontWeight: 600 }}>
              {proposal.envName ?? "new-environment"}
            </span>
            <Tag color={t.color}>{t.label}</Tag>
          </div>
          {proposal.port && <div style={{ fontSize: 12, color: "#64748b" }}>Port {proposal.port}</div>}
        </div>
        {done && <span style={{ color: "#4ade80", fontSize: 18 }}>✓</span>}
      </div>

      {proposal.config && (
        <pre style={{ margin: 0, padding: "10px 14px", background: "#020408", color: "#7dd3fc", fontSize: 11, fontFamily: "monospace", lineHeight: 1.6, borderBottom: "1px solid #0f172a", overflowX: "auto", maxHeight: 140, overflowY: "auto" }}>
          {proposal.config}
        </pre>
      )}

      {!confirmed && !done && (
        <div style={{ padding: "12px 14px", display: "flex", gap: 8 }}>
          <TBtn variant="primary" onClick={onConfirm} full>▶ Confirm & Execute</TBtn>
          <TBtn variant="ghost" onClick={onDismiss} small>✕</TBtn>
        </div>
      )}

      {executing && !done && (
        <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#f59e0b" }}>
          <span style={{ animation: "spin 0.8s linear infinite", display: "inline-block" }}>⟳</span> Executing…
        </div>
      )}

      {done && <div style={{ padding: "10px 14px", fontSize: 13, color: "#4ade80" }}>✓ Completed successfully</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ENV MINI CARD (inside chat + envs tab)
// ─────────────────────────────────────────────────────────────
function EnvCard({ env, onDeploy, onStop, compact }) {
  const t = ENV_TYPES[env.type] ?? ENV_TYPES.docker;
  const s = STATUS_MAP[env.status] ?? STATUS_MAP.idle;
  return (
    <div style={{
      background: "#050a0f",
      border: `1px solid ${env.status === "running" ? s.color + "22" : "#0f172a"}`,
      borderLeft: `3px solid ${s.color}`,
      borderRadius: 10, padding: compact ? "10px 12px" : "14px 16px",
      display: "flex", alignItems: "center", gap: 12,
    }}>
      <div style={{
        width: compact ? 32 : 38, height: compact ? 32 : 38, flexShrink: 0,
        borderRadius: 9, background: `${t.color}15`, border: `1px solid ${t.color}28`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: compact ? 16 : 20,
      }}>{t.icon}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "monospace", fontSize: compact ? 12 : 14, color: "#f1f5f9", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {env.name}
          </span>
          <StatusDot status={env.status} size={6} />
          <Tag color={s.color}>{s.label}</Tag>
        </div>
        <div style={{ fontSize: 11, color: "#475569", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span>{t.label}</span>
          {env.port && <span>:{env.port}</span>}
          <span>⎇ {env.branch}</span>
          <span>{env.lastDeploy}</span>
        </div>
      </div>

      {env.status === "running" ? (
        <TBtn variant="danger" small onClick={() => onStop(env.id)} style={{ minWidth: 64, minHeight: 38 }}>Stop</TBtn>
      ) : (
        <TBtn variant="success" small onClick={() => onDeploy(env.id)} style={{ minWidth: 64, minHeight: 38 }}>Deploy</TBtn>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CHAT MESSAGE
// ─────────────────────────────────────────────────────────────
function ChatMessage({ msg, environments, onDeploy, onStop, onConfirmAction, onDismissAction }) {
  const isUser = msg.role === "user";

  if (msg.role === "system_event") {
    return (
      <div style={{ display: "flex", justifyContent: "center", margin: "8px 0" }}>
        <span style={{ fontSize: 11, color: "#475569", fontFamily: "monospace", background: "#0a0f1a", border: "1px solid #1e293b", padding: "3px 12px", borderRadius: 20 }}>
          {msg.content}
        </span>
      </div>
    );
  }

  if (isUser) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <div style={{
          maxWidth: "82%", background: "#1e3a5f", border: "1px solid #2563eb28",
          borderRadius: "14px 14px 3px 14px", padding: "12px 16px",
          fontSize: 14, color: "#e2e8f0", lineHeight: 1.6,
        }}>{msg.content}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "flex-start" }}>
      <div style={{
        width: 32, height: 32, borderRadius: 9, flexShrink: 0,
        background: "#0a0f1a", border: "1px solid #1e3a5f",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, marginTop: 2,
      }}>🤖</div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {msg.blocks?.map((block, bi) => {
          if (block.type === "text") return <RichText key={bi} text={block.content} streaming={msg.streaming && bi === msg.blocks.length - 1} />;
          if (block.type === "action_proposal") {
            const st = msg.proposalStates?.[block.id] ?? {};
            if (st.dismissed) return null;
            return (
              <ActionProposalCard key={bi} proposal={block.proposal}
                confirmed={st.confirmed} executing={st.executing} done={st.done}
                onConfirm={() => onConfirmAction(msg.id, block.id, block.proposal)}
                onDismiss={() => onDismissAction(msg.id, block.id)}
              />
            );
          }
          if (block.type === "terminal") return <TerminalBlock key={bi} lines={block.lines} height={block.height ?? 180} title={block.title} />;
          if (block.type === "env_list_request") {
            return (
              <div key={bi} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {environments.map(env => <EnvCard key={env.id} env={env} onDeploy={onDeploy} onStop={onStop} compact />)}
              </div>
            );
          }
          return null;
        })}
        {msg.streaming && (!msg.blocks?.length) && (
          <span style={{ display: "inline-block", width: 7, height: 14, background: "#60a5fa", animation: "blink 0.7s step-end infinite" }} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SLIDE-UP SHEET (mobile modal replacement)
// ─────────────────────────────────────────────────────────────
function SlideSheet({ open, onClose, title, children, fullHeight }) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 800 }}>
      <div style={{ position: "absolute", inset: 0, background: "#00000070" }} onClick={onClose} />
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        background: "#050a0f", borderRadius: "18px 18px 0 0",
        border: "1px solid #1e293b", borderBottom: "none",
        maxHeight: fullHeight ? "92vh" : "75vh",
        display: "flex", flexDirection: "column",
        animation: "slideUp 0.25s ease",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid #0f172a", flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "#f1f5f9" }}>{title}</span>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, background: "#0f172a", border: "1px solid #1e293b", color: "#64748b", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px 8px", WebkitOverflowScrolling: "touch" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ENVS PANEL CONTENT (shared between tab + sidebar)
// ─────────────────────────────────────────────────────────────
function EnvsPanel({ environments, onDeploy, onStop, onAddEnv, deployLogs }) {
  const running = environments.filter(e => e.status === "running").length;
  const building = environments.filter(e => ["building","deploying"].includes(e.status)).length;
  const stopped = environments.filter(e => e.status === "stopped").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        {[
          { label: "Running", n: running,                  color: "#22c55e" },
          { label: "Building",n: building,                  color: "#f59e0b" },
          { label: "Stopped", n: stopped,                   color: "#ef4444" },
          { label: "Total",   n: environments.length,       color: "#60a5fa" },
        ].map(s => (
          <div key={s.label} style={{ background: "#050a0f", border: "1px solid #0f172a", borderRadius: 10, padding: "10px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "monospace" }}>{s.n}</div>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: 1, marginTop: 2 }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      <TBtn variant="primary" full onClick={onAddEnv}>＋ New Environment</TBtn>

      {environments.map(env => <EnvCard key={env.id} env={env} onDeploy={onDeploy} onStop={onStop} />)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LOGS PANEL
// ─────────────────────────────────────────────────────────────
function LogsPanel({ environments, deployLogs }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {environments.map(env => {
        const lines = deployLogs[env.id] ?? env.logs ?? [];
        return (
          <div key={env.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <StatusDot status={env.status} size={6} />
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#64748b" }}>{env.name}</span>
              <Tag color={STATUS_MAP[env.status]?.color ?? "#64748b"}>{(STATUS_MAP[env.status]?.label ?? "IDLE")}</Tag>
            </div>
            <TerminalBlock lines={lines} height={120} />
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// LANG COLORS (GitHub linguist palette subset)
// ─────────────────────────────────────────────────────────────
const LANG_COLORS = {
  JavaScript:"#f1e05a", TypeScript:"#3178c6", Python:"#3572A5",
  Rust:"#dea584", Kotlin:"#A97BFF", Java:"#b07219", Go:"#00ADD8",
  Ruby:"#701516", PHP:"#4F5D95", "C++":"#f34b7d", C:"#555555",
  Swift:"#F05138", Dart:"#00B4AB",
};

// ─────────────────────────────────────────────────────────────
// GITHUB PANEL — Full OAuth + webhook integration
// ─────────────────────────────────────────────────────────────
function GitHubPanel({ onImportToEnv, ghSettings, ghToken, setGhToken, onAutoDeployTrigger }) {
  // Auth state
  const [authStatus, setAuthStatus] = useState(() => ghToken ? "authenticated" : "idle");
  const [ghUser,     setGhUser]     = useState(null);
  const [authError,  setAuthError]  = useState("");

  // Repo browsing state
  const [repos,        setRepos]        = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [branches,     setBranches]     = useState([]);
  const [activeBranch, setActiveBranch] = useState("");
  const [commits,      setCommits]      = useState([]);
  const [tree,         setTree]         = useState([]);
  const [fileContent,  setFileContent]  = useState(null);
  const [openFile,     setOpenFile]     = useState(null);

  // Webhook state — per repo, keyed by full_name
  const [webhookIds,   setWebhookIds]   = useState({});  // { "owner/repo": hookId }
  const [whEvents,     setWhEvents]     = useState({});  // { "owner/repo": [event,...] }
  const [lastPolled,   setLastPolled]   = useState({});  // { "owner/repo": timestamp }
  const [autoDeployCfg,setAutoDeployCfg]= useState({});  // { "owner/repo": { enabled, onPush, onMerge, branch } }

  // UI state
  const [view,    setView]    = useState("repos"); // repos | repo_detail | file_viewer
  const [loading, setLoading] = useState("");
  const [error,   setError]   = useState("");

  const pollTimers = useRef({});
  const seenEvents = useRef(new Set());

  const cfUrl = getCFWorkerUrl(ghSettings);
  const clientId = ghSettings?.ghClientId ?? "";

  // ── Helpers ────────────────────────────────────────────────
  const load = useCallback(async (label, fn) => {
    setLoading(label); setError("");
    try   { return await fn(); }
    catch (e) { setError(e.message); return null; }
    finally   { setLoading(""); }
  }, []);

  // ── On mount: if we have a token, verify + load repos ──────
  useEffect(() => {
    if (ghToken && authStatus === "authenticated" && !ghUser) {
      load("Verifying session…", () => ghFetchUser(ghToken))
        .then(u => { if (u) { setGhUser(u); return load("Loading repos…", () => ghFetchRepos(ghToken)); } })
        .then(r => { if (r) setRepos(r); });
    }
  }, []);

  // ── OAuth redirect: handle ?code=&state= on load ───────────
  useEffect(() => {
    const cb = parseOAuthCallback(window.location.search);
    if (!cb.ok) return;

    const savedState = sessionStorage.getItem("gh_oauth_state");
    sessionStorage.removeItem("gh_oauth_state");

    // Clear the callback params from URL without a reload
    window.history.replaceState({}, "", window.location.pathname);

    if (cb.state !== savedState) {
      setAuthError("OAuth state mismatch — possible CSRF. Please try again.");
      setAuthStatus("error");
      return;
    }

    if (!cfUrl) {
      setAuthError("CF Worker URL not set. Add it in ⚙ Settings → GitHub.");
      setAuthStatus("error");
      return;
    }

    setAuthStatus("exchanging");
    exchangeCodeForToken(cfUrl, cb.code, window.location.origin + window.location.pathname)
      .then(async (data) => {
        setGhToken(data.access_token);
        setAuthStatus("authenticated");
        const u = await ghFetchUser(data.access_token);
        setGhUser(u);
        const r = await ghFetchRepos(data.access_token);
        setRepos(r ?? []);
      })
      .catch(e => { setAuthError(e.message); setAuthStatus("error"); });
  }, []);

  // ── Start OAuth redirect flow ───────────────────────────────
  const startOAuth = () => {
    if (!clientId) { setAuthError("GitHub OAuth App Client ID not set — add it in ⚙ Settings → GitHub."); return; }
    if (!cfUrl)    { setAuthError("CF Worker URL not set — add it in ⚙ Settings → GitHub."); return; }
    const state = generateOAuthState();
    sessionStorage.setItem("gh_oauth_state", state);
    const redirectUri = window.location.origin + window.location.pathname;
    window.location.href = buildOAuthRedirectURL(clientId, redirectUri, state);
  };

  // ── Disconnect ──────────────────────────────────────────────
  const disconnect = () => {
    setGhToken(null); setGhUser(null); setRepos([]); setAuthStatus("idle");
    setSelectedRepo(null); setAuthError(""); setView("repos");
    Object.values(pollTimers.current).forEach(clearInterval);
    pollTimers.current = {};
  };

  // ── Open repo detail ────────────────────────────────────────
  const openRepo = useCallback(async (repo) => {
    setSelectedRepo(repo); setView("repo_detail");
    setCommits([]); setTree([]); setBranches([]);

    const br = await load("Loading branches…", () => ghFetchBranches(ghToken, repo.full_name));
    if (!br) return;
    setBranches(br);
    const defaultBr = br.find(b => b.name === repo.default_branch)?.name ?? br[0]?.name ?? "main";
    setActiveBranch(defaultBr);

    const [cms, tr] = await Promise.all([
      load("Loading commits…", () => ghFetchCommits(ghToken, repo.full_name, defaultBr)),
      load("Loading tree…",    () => ghFetchTree(ghToken, repo.full_name, defaultBr)),
    ]);
    if (cms) setCommits(cms);
    if (tr)  setTree(tr.tree ?? []);
  }, [ghToken, load]);

  const switchBranch = useCallback(async (br) => {
    if (!selectedRepo) return;
    setActiveBranch(br); setCommits([]); setTree([]);
    const [cms, tr] = await Promise.all([
      load("Loading commits…", () => ghFetchCommits(ghToken, selectedRepo.full_name, br)),
      load("Loading tree…",    () => ghFetchTree(ghToken, selectedRepo.full_name, br)),
    ]);
    if (cms) setCommits(cms);
    if (tr)  setTree(tr.tree ?? []);
  }, [ghToken, selectedRepo, load]);

  const viewFile = useCallback(async (filePath) => {
    if (!selectedRepo) return;
    setOpenFile(filePath); setFileContent(null); setView("file_viewer");
    const content = await load("Reading file…", () =>
      ghFetchFileContent(ghToken, selectedRepo.full_name, filePath, activeBranch)
    );
    if (content !== null) setFileContent(content);
  }, [ghToken, selectedRepo, activeBranch, load]);

  // ── Register/unregister webhook for a repo ──────────────────
  const registerWebhook = useCallback(async (repo) => {
    if (!cfUrl) { setError("CF Worker URL required for webhooks — set in ⚙ Settings → GitHub."); return; }
    const hook = await load("Creating webhook…", () =>
      ghCreateWebhook(ghToken, repo.full_name, cfUrl, ghSettings?.webhookSecret ?? "")
    );
    if (!hook?.id) return;
    setWebhookIds(prev => ({ ...prev, [repo.full_name]: hook.id }));
    startPolling(repo.full_name);
  }, [ghToken, cfUrl, ghSettings, load]);

  const unregisterWebhook = useCallback(async (repo) => {
    const hookId = webhookIds[repo.full_name];
    if (!hookId) return;
    await load("Removing webhook…", () => ghDeleteWebhook(ghToken, repo.full_name, hookId));
    setWebhookIds(prev => { const n = { ...prev }; delete n[repo.full_name]; return n; });
    stopPolling(repo.full_name);
  }, [ghToken, webhookIds, load]);

  // ── Webhook polling ─────────────────────────────────────────
  const startPolling = useCallback((fullName) => {
    if (pollTimers.current[fullName]) return;
    const poll = async () => {
      if (!cfUrl || !ghToken) return;
      const since = lastPolled.current?.[fullName] ?? 0;
      const events = await pollWebhookEvents(cfUrl, fullName, since);
      if (!events.length) return;

      const newEvents = events.filter(e => !seenEvents.current.has(e.id));
      newEvents.forEach(e => seenEvents.current.add(e.id));

      if (newEvents.length) {
        setWhEvents(prev => ({
          ...prev,
          [fullName]: [...newEvents.map(processWebhookEvent), ...(prev[fullName] ?? [])].slice(0, 20),
        }));
        setLastPolled(prev => ({ ...prev, [fullName]: Date.now() }));

        // Auto-deploy check
        const cfg = autoDeployCfg[fullName];
        for (const evt of newEvents.map(processWebhookEvent)) {
          if (shouldAutoDeploy(evt, cfg)) {
            onAutoDeployTrigger?.(fullName, evt);
          }
        }
      }
    };
    poll(); // immediate
    pollTimers.current[fullName] = setInterval(poll, 30000);
  }, [cfUrl, ghToken, autoDeployCfg, onAutoDeployTrigger]);

  const stopPolling = (fullName) => {
    clearInterval(pollTimers.current[fullName]);
    delete pollTimers.current[fullName];
  };

  // Cleanup on unmount
  useEffect(() => () => Object.values(pollTimers.current).forEach(clearInterval), []);

  // ── Import repo as environment ──────────────────────────────
  const importToEnv = (repo) => {
    onImportToEnv({
      name:      repo.name,
      type:      detectEnvType(repo.language),
      branch:    repo.default_branch ?? "main",
      githubUrl: repo.clone_url,
      fullName:  repo.full_name,
    });
  };

  // ── Shared styles ───────────────────────────────────────────
  const IS = { width:"100%", background:"#0a0f1a", border:"1px solid #1e293b", borderRadius:8, padding:"12px 14px", color:"#e2e8f0", fontSize:14, fontFamily:"monospace", outline:"none", boxSizing:"border-box" };
  const ERR = (msg) => msg ? (
    <div style={{ background:"#1c0a0a", border:"1px solid #dc262640", borderRadius:8, padding:"10px 14px", fontSize:12, color:"#f87171", fontFamily:"monospace" }}>⚠ {msg}</div>
  ) : null;

  // ── NOT connected ───────────────────────────────────────────
  if (authStatus !== "authenticated") {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ background:"#0a0f1a", border:"1px solid #1e293b", borderRadius:12, padding:18 }}>
          <div style={{ fontSize:28, marginBottom:10 }}>🐙</div>
          <div style={{ fontSize:15, fontWeight:600, color:"#f1f5f9", marginBottom:6 }}>Connect GitHub</div>
          <div style={{ fontSize:13, color:"#64748b", lineHeight:1.65 }}>
            Login with your GitHub account via OAuth to browse repos, view commits, manage webhooks, and trigger auto-deployments on push or PR merge.
          </div>
        </div>

        {authStatus === "exchanging" && (
          <div style={{ display:"flex", alignItems:"center", gap:10, background:"#0a0f1a", border:"1px solid #1e3a5f", borderRadius:10, padding:14 }}>
            <span style={{ animation:"spin 0.8s linear infinite", display:"inline-block", fontSize:18 }}>⟳</span>
            <span style={{ fontSize:13, color:"#60a5fa" }}>Completing login…</span>
          </div>
        )}

        {ERR(authError)}

        {(!clientId || !cfUrl) && (
          <div style={{ background:"#1c1400", border:"1px solid #f59e0b40", borderRadius:10, padding:14, fontSize:12, color:"#fbbf24", lineHeight:1.7 }}>
            ⚠ <strong>Setup required before login:</strong><br/>
            1. Deploy <code style={{ color:"#7dd3fc" }}>cf-worker.js</code> to Cloudflare Workers<br/>
            2. Create a GitHub OAuth App (Settings → Developer Settings)<br/>
            3. Set Client ID + Worker URL in ⚙ Settings → GitHub
          </div>
        )}

        <TBtn variant="primary" full onClick={startOAuth} disabled={authStatus === "exchanging"}>
          🐙 Login with GitHub
        </TBtn>

        <div style={{ background:"#050a0f", border:"1px solid #1e293b", borderRadius:10, padding:14 }}>
          <div style={{ fontSize:10, color:"#475569", letterSpacing:1.5, textTransform:"uppercase", marginBottom:10 }}>Quick Setup</div>
          {[
            "1. Deploy cf-worker.js → Cloudflare Workers dashboard",
            "2. github.com/settings/developers → New OAuth App",
            "   Homepage URL: your PWA URL (e.g. app.pages.dev)",
            "   Callback URL: same as Homepage URL",
            "3. Copy Client ID → ⚙ Settings → GitHub → Client ID",
            "4. Copy Worker URL → ⚙ Settings → GitHub → Worker URL",
            "5. Come back here and tap Login with GitHub",
          ].map((s, i) => (
            <div key={i} style={{ fontSize:11, color:"#64748b", fontFamily:"monospace", marginBottom:4, lineHeight:1.6 }}>{s}</div>
          ))}
        </div>
      </div>
    );
  }

  // ── FILE VIEWER ─────────────────────────────────────────────
  if (view === "file_viewer") {
    const ext  = openFile?.split(".").pop()?.toLowerCase() ?? "";
    const langLabel = { js:"JS", ts:"TS", jsx:"JSX", tsx:"TSX", py:"PYTHON", rs:"RUST", go:"GO", kt:"KOTLIN", java:"JAVA", yml:"YAML", yaml:"YAML", toml:"TOML", sh:"BASH", md:"MARKDOWN", json:"JSON", html:"HTML", css:"CSS", dockerfile:"DOCKERFILE" }[ext] ?? ext.toUpperCase();
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <button onClick={() => setView("repo_detail")} style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:7, padding:"6px 12px", color:"#60a5fa", cursor:"pointer", fontSize:12, fontFamily:"monospace", minHeight:36 }}>← Back</button>
          <span style={{ fontSize:11, color:"#94a3b8", fontFamily:"monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{openFile}</span>
        </div>
        {loading && <div style={{ fontSize:12, color:"#f59e0b", fontFamily:"monospace" }}>⟳ {loading}</div>}
        {ERR(error)}
        {fileContent !== null && (
          <div style={{ borderRadius:8, overflow:"hidden", border:"1px solid #1e293b" }}>
            <div style={{ background:"#0a0f1a", padding:"5px 12px", fontSize:9, color:"#475569", fontFamily:"monospace", letterSpacing:1.2, borderBottom:"1px solid #0f172a", display:"flex", justifyContent:"space-between" }}>
              <span>{langLabel}</span>
              <span>{fileContent.split("\n").length} lines</span>
            </div>
            <pre style={{ margin:0, padding:"12px", background:"#020408", color:"#7dd3fc", fontSize:11, fontFamily:"monospace", lineHeight:1.7, overflowX:"auto", maxHeight:440, overflowY:"auto", WebkitOverflowScrolling:"touch", whiteSpace:"pre" }}>
              {fileContent}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ── REPO DETAIL ─────────────────────────────────────────────
  if (view === "repo_detail" && selectedRepo) {
    const KEY_FILES = ["Dockerfile","docker-compose.yml","Cargo.toml","package.json","requirements.txt","build.gradle","nginx.conf","Makefile",".github"];
    const allFiles = tree.filter(f => f.type === "blob").slice(0, 80);
    const keyFiles = allFiles.filter(f => KEY_FILES.some(k => f.path.startsWith(k) || f.path.includes("/" + k)));
    const otherFiles = allFiles.filter(f => !KEY_FILES.some(k => f.path.startsWith(k) || f.path.includes("/" + k)));
    const fileIcon = (p) => p.includes("Dockerfile") ? "🐳" : p.includes("Cargo") ? "🦀" : p.includes("package.json") ? "⬡" : p.includes("requirements") ? "🐍" : p.includes("gradle") ? "🤖" : p.endsWith(".yml") || p.endsWith(".yaml") ? "⚙" : "📄";

    const hasWebhook = !!webhookIds[selectedRepo.full_name];
    const repoEvents = whEvents[selectedRepo.full_name] ?? [];
    const autoCfg = autoDeployCfg[selectedRepo.full_name] ?? { enabled: false, onPush: true, onMerge: true, branch: selectedRepo.default_branch ?? "main" };
    const setAutoCfg = (patch) => setAutoDeployCfg(prev => ({ ...prev, [selectedRepo.full_name]: { ...autoCfg, ...patch } }));

    return (
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <button onClick={() => { setView("repos"); setSelectedRepo(null); }} style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:7, padding:"6px 12px", color:"#60a5fa", cursor:"pointer", fontSize:12, fontFamily:"monospace", minHeight:36 }}>← Repos</button>
          <span style={{ fontFamily:"monospace", fontSize:13, color:"#f1f5f9", fontWeight:600, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{selectedRepo.name}</span>
          {selectedRepo.private && <Tag color="#f59e0b">PRIVATE</Tag>}
        </div>

        {/* Branch selector */}
        {branches.length > 0 && (
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:13, color:"#475569" }}>⎇</span>
            <select value={activeBranch} onChange={e => switchBranch(e.target.value)} style={{ flex:1, background:"#0a0f1a", border:"1px solid #1e293b", borderRadius:7, padding:"8px 10px", color:"#e2e8f0", fontSize:12, fontFamily:"monospace" }}>
              {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>
        )}

        {loading && <div style={{ fontSize:12, color:"#f59e0b", fontFamily:"monospace" }}>⟳ {loading}</div>}
        {ERR(error)}

        {/* Action row */}
        <div style={{ display:"flex", gap:7 }}>
          <TBtn variant="success" small onClick={() => importToEnv(selectedRepo)} style={{ flex:1, minHeight:38, fontSize:11 }}>＋ Import Env</TBtn>
          <TBtn variant={hasWebhook ? "danger" : "ghost"} small onClick={() => hasWebhook ? unregisterWebhook(selectedRepo) : registerWebhook(selectedRepo)} style={{ flex:1, minHeight:38, fontSize:11 }}>
            {hasWebhook ? "🔔 Remove Hook" : "🔔 Add Webhook"}
          </TBtn>
        </div>

        {/* Webhook events */}
        {hasWebhook && (
          <div style={{ background:"#050a0f", border:"1px solid #1e3a5f", borderRadius:10, padding:12 }}>
            <div style={{ fontSize:10, color:"#475569", letterSpacing:1.2, textTransform:"uppercase", marginBottom:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span>Live Events (polling 30s)</span>
              <span style={{ color:"#22c55e", fontSize:9 }}>● ACTIVE</span>
            </div>

            {/* Auto-deploy toggle */}
            <div style={{ background:"#0a0f1a", borderRadius:8, padding:10, marginBottom:8 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:autoCfg.enabled ? 8 : 0 }}>
                <span style={{ fontSize:12, color:"#94a3b8" }}>Auto-deploy</span>
                <button onClick={() => setAutoCfg({ enabled: !autoCfg.enabled })} style={{ background: autoCfg.enabled ? "#14532d" : "#0f172a", border:`1px solid ${autoCfg.enabled ? "#16a34a" : "#1e293b"}`, borderRadius:20, padding:"3px 12px", color: autoCfg.enabled ? "#4ade80" : "#64748b", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
                  {autoCfg.enabled ? "ON" : "OFF"}
                </button>
              </div>
              {autoCfg.enabled && (
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"#64748b", width:80 }}>On push to</span>
                    <input value={autoCfg.branch} onChange={e => setAutoCfg({ branch: e.target.value })} style={{ flex:1, background:"#050a0f", border:"1px solid #1e293b", borderRadius:5, padding:"4px 8px", color:"#e2e8f0", fontSize:11, fontFamily:"monospace", outline:"none" }} />
                    <button onClick={() => setAutoCfg({ onPush: !autoCfg.onPush })} style={{ background: autoCfg.onPush ? "#14532d" : "#0f172a", border:`1px solid ${autoCfg.onPush ? "#16a34a" : "#1e293b"}`, borderRadius:4, padding:"3px 8px", color: autoCfg.onPush ? "#4ade80" : "#64748b", cursor:"pointer", fontSize:10 }}>
                      {autoCfg.onPush ? "✓" : "○"}
                    </button>
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"#64748b", width:80 }}>On PR merge</span>
                    <button onClick={() => setAutoCfg({ onMerge: !autoCfg.onMerge })} style={{ background: autoCfg.onMerge ? "#14532d" : "#0f172a", border:`1px solid ${autoCfg.onMerge ? "#16a34a" : "#1e293b"}`, borderRadius:4, padding:"3px 8px", color: autoCfg.onMerge ? "#4ade80" : "#64748b", cursor:"pointer", fontSize:10 }}>
                      {autoCfg.onMerge ? "✓" : "○"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {repoEvents.length === 0
              ? <div style={{ fontSize:11, color:"#334155", fontFamily:"monospace" }}>No events yet — waiting for GitHub push/PR…</div>
              : repoEvents.slice(0, 6).map((evt, i) => (
                <div key={evt.id ?? i} style={{ display:"flex", gap:8, alignItems:"flex-start", padding:"7px 0", borderBottom: i < repoEvents.length - 1 ? "1px solid #0f172a" : "none" }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background: evt.color, flexShrink:0, marginTop:4 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, color:"#e2e8f0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{evt.label}</div>
                    {evt.detail && <div style={{ fontSize:10, color:"#64748b", marginTop:2 }}>{evt.detail}</div>}
                    <div style={{ fontSize:10, color:"#334155", marginTop:2 }}>{evt.ts ? new Date(evt.ts).toLocaleTimeString() : ""}</div>
                  </div>
                </div>
              ))
            }
          </div>
        )}

        {/* Key config files */}
        {keyFiles.length > 0 && (
          <div>
            <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Config Files</div>
            {keyFiles.map(f => (
              <button key={f.path} onClick={() => viewFile(f.path)} style={{ display:"flex", alignItems:"center", gap:8, width:"100%", background:"#050a0f", border:"1px solid #1e3a5f", borderRadius:7, padding:"9px 12px", marginBottom:5, cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>
                <span style={{ fontSize:14 }}>{fileIcon(f.path)}</span>
                <span style={{ fontFamily:"monospace", fontSize:12, color:"#7dd3fc", flex:1, textAlign:"left", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.path}</span>
                <span style={{ fontSize:10, color:"#334155" }}>→</span>
              </button>
            ))}
          </div>
        )}

        {/* Recent commits */}
        {commits.length > 0 && (
          <div>
            <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Recent Commits</div>
            {commits.slice(0, 10).map(c => {
              const sha    = c.sha.slice(0, 7);
              const msg    = c.commit.message.split("\n")[0].slice(0, 62);
              const author = c.commit.author.name;
              const date   = new Date(c.commit.author.date).toLocaleDateString();
              return (
                <div key={c.sha} style={{ background:"#050a0f", border:"1px solid #0f172a", borderRadius:7, padding:"9px 12px", marginBottom:5 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:2 }}>
                    <code style={{ fontSize:10, color:"#f59e0b", background:"#1c1400", padding:"1px 5px", borderRadius:3, flexShrink:0 }}>{sha}</code>
                    <span style={{ fontSize:11, color:"#94a3b8", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{msg}</span>
                  </div>
                  <div style={{ fontSize:10, color:"#334155" }}>{author} · {date}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* All other files */}
        {otherFiles.length > 0 && (
          <div>
            <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Files ({allFiles.length})</div>
            <div style={{ background:"#050a0f", border:"1px solid #0f172a", borderRadius:8, overflow:"hidden" }}>
              {otherFiles.slice(0, 40).map((f, i) => (
                <button key={f.path} onClick={() => viewFile(f.path)} style={{ display:"flex", alignItems:"center", gap:8, width:"100%", background:"transparent", border:"none", borderBottom: i < otherFiles.length - 1 ? "1px solid #0a0f1a" : "none", padding:"9px 12px", cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>
                  <span style={{ fontSize:11 }}>📄</span>
                  <span style={{ fontFamily:"monospace", fontSize:11, color:"#94a3b8", flex:1, textAlign:"left", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── REPO LIST ───────────────────────────────────────────────
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {/* User card */}
      <div style={{ background:"#0a0f1a", border:"1px solid #1e3a5f", borderRadius:12, padding:"12px 14px", display:"flex", alignItems:"center", gap:12 }}>
        {ghUser?.avatar_url && <img src={ghUser.avatar_url} alt="" style={{ width:40, height:40, borderRadius:"50%", border:"2px solid #2563eb" }} />}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:14, fontWeight:600, color:"#f1f5f9" }}>{ghUser?.name ?? ghUser?.login}</div>
          <div style={{ fontSize:11, color:"#475569" }}>@{ghUser?.login} · {ghUser?.public_repos} repos</div>
        </div>
        <button onClick={disconnect} style={{ background:"#0f172a", border:"1px solid #dc2626", borderRadius:7, padding:"5px 10px", color:"#f87171", cursor:"pointer", fontSize:11, WebkitTapHighlightColor:"transparent" }}>Sign out</button>
      </div>

      {loading && <div style={{ fontSize:12, color:"#f59e0b", fontFamily:"monospace" }}>⟳ {loading}</div>}
      {ERR(error)}

      <div style={{ fontSize:11, color:"#475569", letterSpacing:1, textTransform:"uppercase" }}>Repositories ({repos.length})</div>

      {repos.map(repo => {
        const langColor = LANG_COLORS[repo.language] ?? "#64748b";
        const envInfo   = ENV_TYPES[detectEnvType(repo.language)] ?? ENV_TYPES.docker;
        const hasHook   = !!webhookIds[repo.full_name];
        return (
          <div key={repo.id} style={{ background:"#050a0f", border:`1px solid ${hasHook ? "#3b82f640" : "#0f172a"}`, borderRadius:10, overflow:"hidden" }}>
            <button onClick={() => openRepo(repo)} style={{ display:"flex", alignItems:"flex-start", gap:12, width:"100%", background:"transparent", border:"none", padding:"12px 14px", cursor:"pointer", WebkitTapHighlightColor:"transparent", textAlign:"left" }}>
              <span style={{ fontSize:18, marginTop:2 }}>{envInfo.icon}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3, flexWrap:"wrap" }}>
                  <span style={{ fontFamily:"monospace", fontSize:13, color:"#f1f5f9", fontWeight:600 }}>{repo.name}</span>
                  {repo.private && <Tag color="#f59e0b">PRIVATE</Tag>}
                  <Tag color={langColor}>{repo.language ?? "—"}</Tag>
                  {hasHook && <Tag color="#22c55e">WEBHOOK</Tag>}
                </div>
                {repo.description && <div style={{ fontSize:11, color:"#64748b", marginBottom:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{repo.description}</div>}
                <div style={{ display:"flex", gap:10, fontSize:10, color:"#334155" }}>
                  <span>⎇ {repo.default_branch}</span>
                  <span>★ {repo.stargazers_count}</span>
                  <span>{new Date(repo.pushed_at).toLocaleDateString()}</span>
                </div>
              </div>
              <span style={{ color:"#334155", fontSize:14, marginTop:2 }}>›</span>
            </button>
            <div style={{ borderTop:"1px solid #0a0f1a", padding:"8px 14px", display:"flex", gap:7 }}>
              <TBtn variant="success" small onClick={e => { e.stopPropagation(); importToEnv(repo); }} style={{ fontSize:11, minHeight:34, flex:1 }}>＋ Import</TBtn>
              <TBtn variant="ghost"   small onClick={e => { e.stopPropagation(); openRepo(repo); }}   style={{ fontSize:11, minHeight:34, flex:1 }}>Browse →</TBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS PANEL — AI Backends + GitHub OAuth config
// ─────────────────────────────────────────────────────────────
function SettingsPanel({ activeBackend, setActiveBackend, activeModel, setActiveModel, openrouterKey, setOpenrouterKey, ghSettings, setGhSettings }) {
  const [tab, setTab] = useState("ai"); // ai | github

  const IS = { width:"100%", background:"#050a0f", border:"1px solid #1e293b", borderRadius:7, padding:"10px 12px", color:"#e2e8f0", fontSize:13, fontFamily:"monospace", outline:"none", boxSizing:"border-box" };
  const setGh = (k, v) => setGhSettings(s => ({ ...s, [k]: v }));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {/* Sub-tab row */}
      <div style={{ display:"flex", borderBottom:"1px solid #0f172a", marginBottom:14, flexShrink:0 }}>
        {[{ id:"ai", label:"AI Backends" }, { id:"github", label:"🐙 GitHub OAuth" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex:1, padding:"9px 6px", background: tab===t.id ? "#0f172a" : "transparent", color: tab===t.id ? "#e2e8f0" : "#475569", border:"none", borderBottom:`2px solid ${tab===t.id ? "#3b82f6" : "transparent"}`, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── AI tab ── */}
      {tab === "ai" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {Object.values(AI_BACKENDS).map(b => (
            <div key={b.id} onClick={() => { setActiveBackend(b.id); setActiveModel(b.models[0]); }}
              style={{ background:"#0a0f1a", borderRadius:10, padding:14, border:`1px solid ${activeBackend===b.id ? b.color+"55" : "#1e293b"}`, cursor:"pointer" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                <div style={{ width:10, height:10, borderRadius:"50%", background:b.color, boxShadow: activeBackend===b.id ? `0 0 10px ${b.color}` : "none" }} />
                <span style={{ fontWeight:600, fontSize:14, color:"#f1f5f9" }}>{b.label}</span>
                {activeBackend===b.id && <Tag color={b.color}>ACTIVE</Tag>}
              </div>
              <div style={{ fontSize:11, color:"#475569", fontFamily:"monospace", marginBottom:4 }}>{b.endpoint}</div>
              <div style={{ fontSize:11, color:"#334155" }}>{b.note}</div>
              {b.id==="openrouter" && activeBackend==="openrouter" && (
                <input value={openrouterKey} onChange={e => { e.stopPropagation(); setOpenrouterKey(e.target.value); }} onClick={e=>e.stopPropagation()} placeholder="sk-or-v1-…" type="password" style={{ ...IS, marginTop:8 }} />
              )}
              {activeBackend===b.id && (
                <div style={{ marginTop:10 }}>
                  <div style={{ fontSize:10, color:"#334155", letterSpacing:1, marginBottom:5 }}>MODEL</div>
                  <select value={activeModel} onChange={e => setActiveModel(e.target.value)} onClick={e=>e.stopPropagation()} style={{ ...IS }}>
                    {b.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              )}
            </div>
          ))}

          <div style={{ background:"#020408", borderRadius:8, padding:12, fontSize:11, fontFamily:"monospace", color:"#334155", lineHeight:2 }}>
            <div style={{ color:"#475569", marginBottom:4, letterSpacing:1 }}>CONNECTION MATRIX</div>
            <div>Claude     → HTTPS (claude.ai artifact proxy)</div>
            <div>Ollama     → HTTP  localhost:11434</div>
            <div>OpenRouter → HTTPS + Bearer token</div>
          </div>
        </div>
      )}

      {/* ── GitHub tab ── */}
      {tab === "github" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ background:"#0a0f1a", border:"1px solid #1e2d40", borderRadius:10, padding:14 }}>
            <div style={{ fontSize:12, fontWeight:600, color:"#f1f5f9", marginBottom:10 }}>🐙 GitHub OAuth App</div>
            <div style={{ fontSize:11, color:"#475569", lineHeight:1.7, marginBottom:10 }}>
              Create at <code style={{ color:"#7dd3fc" }}>github.com/settings/developers</code> → OAuth Apps → New OAuth App.<br/>
              Set both Homepage and Callback URL to your PWA's URL.
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <div>
                <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:5 }}>Client ID</div>
                <input value={ghSettings?.ghClientId ?? ""} onChange={e => setGh("ghClientId", e.target.value)} placeholder="Iv1.xxxxxxxxxxxx" style={IS} />
              </div>
            </div>
          </div>

          <div style={{ background:"#0a0f1a", border:"1px solid #1e2d40", borderRadius:10, padding:14 }}>
            <div style={{ fontSize:12, fontWeight:600, color:"#f1f5f9", marginBottom:10 }}>☁ Cloudflare Worker</div>
            <div style={{ fontSize:11, color:"#475569", lineHeight:1.7, marginBottom:10 }}>
              Deploy <code style={{ color:"#7dd3fc" }}>cf-worker.js</code> to Cloudflare Workers. Set env vars: <code style={{ color:"#7dd3fc" }}>CLIENT_ID</code>, <code style={{ color:"#7dd3fc" }}>CLIENT_SECRET</code>, <code style={{ color:"#7dd3fc" }}>WEBHOOK_SECRET</code>. Bind a KV namespace as <code style={{ color:"#7dd3fc" }}>EVENTS</code>.
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <div>
                <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:5 }}>Worker URL</div>
                <input value={ghSettings?.cfWorkerUrl ?? ""} onChange={e => setGh("cfWorkerUrl", e.target.value)} placeholder="https://devopsai.YOUR_NAME.workers.dev" style={IS} />
              </div>
              <div>
                <div style={{ fontSize:10, color:"#475569", letterSpacing:1, textTransform:"uppercase", marginBottom:5 }}>Webhook Secret (optional)</div>
                <input value={ghSettings?.webhookSecret ?? ""} onChange={e => setGh("webhookSecret", e.target.value)} placeholder="random string matching WEBHOOK_SECRET on Worker" type="password" style={IS} />
              </div>
            </div>
          </div>

          {(ghSettings?.cfWorkerUrl && ghSettings?.ghClientId) && (
            <div style={{ background:"#052e16", border:"1px solid #16a34a", borderRadius:8, padding:"10px 14px", fontSize:12, color:"#4ade80" }}>
              ✓ GitHub OAuth configured — go to the 🐙 GitHub tab to connect
            </div>
          )}
        </div>
      )}
    </div>
  );
}
  const [repos, setRepos]       = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [branches, setBranches] = useState([]);
  const [activeBranch, setActiveBranch] = useState("");
  const [commits, setCommits]   = useState([]);
  const [tree, setTree]         = useState([]);
  const [fileContent, setFileContent] = useState(null);
  const [openFile, setOpenFile] = useState(null);
  const [view, setView]         = useState("repos"); // repos | repo_detail | file_viewer
  const [loading, setLoading]   = useState("");
  const [error, setError]       = useState("");

  const isPAT = !!pat;

  const load = useCallback(async (label, fn) => {
    setLoading(label);
    setError("");
    try {
      const result = await fn();
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading("");
    }
  }, []);

  const connect = useCallback(async () => {
    const token = patInput.trim();
    if (!validatePAT(token)) {
      setError("Token must start with ghp_ or github_pat_ and be at least 10 chars");
      return;
    }
    const user = await load("Connecting…", () => ghFetchUser(token));
    if (!user) return;
    const repoList = await load("Loading repos…", () => ghFetchRepos(token));
    if (!repoList) return;
    setPat(token);
    setPatInput("");
    setGhUser(user);
    setRepos(repoList);
    try { sessionStorage.setItem("gh_pat", token); } catch {}
  }, [patInput, load]);

  const disconnect = () => {
    setPat(""); setPatInput(""); setGhUser(null); setRepos([]);
    setSelectedRepo(null); setBranches([]); setCommits([]); setTree([]);
    setView("repos"); setError("");
    try { sessionStorage.removeItem("gh_pat"); } catch {}
  };

  // Auto-load on mount if stored PAT exists
  useEffect(() => {
    if (pat && !ghUser) {
      load("Restoring session…", () => ghFetchUser(pat))
        .then(u => { if (u) { setGhUser(u); return load("Loading repos…", () => ghFetchRepos(pat)); } })
        .then(r => { if (r) setRepos(r); })
        .catch(() => { setPat(""); try { sessionStorage.removeItem("gh_pat"); } catch {} });
    }
  }, []);

  const openRepo = useCallback(async (repo) => {
    setSelectedRepo(repo);
    setView("repo_detail");
    setCommits([]); setTree([]); setBranches([]);
    const br = await load("Loading branches…", () => ghFetchBranches(pat, repo.full_name));
    if (!br) return;
    setBranches(br);
    const defaultBr = br.find(b => b.name === repo.default_branch)?.name ?? br[0]?.name ?? "main";
    setActiveBranch(defaultBr);
    const [cms, tr] = await Promise.all([
      load("Loading commits…", () => ghFetchCommits(pat, repo.full_name, defaultBr)),
      load("Loading files…",   () => ghFetchTree(pat, repo.full_name, defaultBr)),
    ]);
    if (cms) setCommits(cms);
    if (tr)  setTree(tr.tree ?? []);
  }, [pat, load]);

  const switchBranch = useCallback(async (br) => {
    if (!selectedRepo) return;
    setActiveBranch(br);
    setCommits([]); setTree([]);
    const [cms, tr] = await Promise.all([
      load("Loading commits…", () => ghFetchCommits(pat, selectedRepo.full_name, br)),
      load("Loading files…",   () => ghFetchTree(pat, selectedRepo.full_name, br)),
    ]);
    if (cms) setCommits(cms);
    if (tr)  setTree(tr.tree ?? []);
  }, [pat, selectedRepo, load]);

  const viewFile = useCallback(async (filePath) => {
    if (!selectedRepo) return;
    setOpenFile(filePath);
    setFileContent(null);
    setView("file_viewer");
    const content = await load("Reading file…", () => ghFetchFileContent(pat, selectedRepo.full_name, filePath, activeBranch));
    if (content !== null) setFileContent(content);
  }, [pat, selectedRepo, activeBranch, load]);

  const importToEnv = (repo) => {
    onImportToEnv({
      name: repo.name,
      type: detectEnvType(repo.language),
      branch: repo.default_branch ?? "main",
      githubUrl: repo.clone_url,
      fullName: repo.full_name,
    });
  };

  const inputStyle = { width: "100%", background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 14px", color: "#e2e8f0", fontSize: 14, fontFamily: "monospace", outline: "none", boxSizing: "border-box" };

  // ── Not connected ──
  if (!isPAT) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 12, padding: 18 }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>🐙</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#f1f5f9", marginBottom: 6 }}>Connect GitHub</div>
          <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
            Use a Personal Access Token to browse repos, view commits, and import projects to environments.
          </div>
        </div>

        <div style={{ background: "#050a0f", border: "1px solid #1e2d40", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: "#475569", letterSpacing: 1, marginBottom: 10, textTransform: "uppercase" }}>
            How to get a PAT
          </div>
          {[
            "1. github.com → Settings → Developer settings",
            "2. Personal access tokens → Tokens (classic)",
            "3. Generate new token → select scopes: repo + read:user",
            "4. Copy the ghp_… token and paste below",
          ].map((step, i) => (
            <div key={i} style={{ fontSize: 12, color: "#64748b", fontFamily: "monospace", marginBottom: 5 }}>{step}</div>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 11, color: "#475569", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
            Personal Access Token
          </div>
          <input
            style={inputStyle}
            value={patInput}
            onChange={e => setPatInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") connect(); }}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            type="password"
            autoComplete="off"
          />
        </div>

        {error && (
          <div style={{ background: "#1c0a0a", border: "1px solid #dc262640", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#f87171", fontFamily: "monospace" }}>
            ⚠ {error}
          </div>
        )}

        <TBtn variant="primary" full onClick={connect} disabled={!patInput.trim()}>
          {loading ? `⟳ ${loading}` : "🔗 Connect GitHub"}
        </TBtn>
      </div>
    );
  }

  // ── File viewer ──
  if (view === "file_viewer") {
    const ext = openFile?.split(".").pop() ?? "";
    const langMap = { js:"javascript", ts:"typescript", jsx:"jsx", tsx:"tsx", py:"python", rs:"rust", go:"go", kt:"kotlin", java:"java", yml:"yaml", yaml:"yaml", toml:"toml", sh:"bash", md:"markdown", json:"json", html:"html", css:"css", dockerfile:"dockerfile" };
    const lang = langMap[ext.toLowerCase()] ?? ext;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setView("repo_detail")} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 7, padding: "6px 12px", color: "#60a5fa", cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}>← Back</button>
          <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{openFile}</span>
        </div>
        {loading && <div style={{ fontSize: 12, color: "#f59e0b", fontFamily: "monospace" }}>⟳ {loading}</div>}
        {fileContent !== null && (
          <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #1e293b" }}>
            <div style={{ background: "#0a0f1a", padding: "5px 12px", fontSize: 9, color: "#475569", fontFamily: "monospace", letterSpacing: 1, borderBottom: "1px solid #0f172a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{lang.toUpperCase()}</span>
              <span>{fileContent.split("\n").length} lines</span>
            </div>
            <pre style={{ margin: 0, padding: "12px", background: "#020408", color: "#7dd3fc", fontSize: 11, fontFamily: "monospace", lineHeight: 1.7, overflowX: "auto", maxHeight: 420, overflowY: "auto", WebkitOverflowScrolling: "touch", whiteSpace: "pre" }}>
              {fileContent}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ── Repo detail ──
  if (view === "repo_detail" && selectedRepo) {
    const displayFiles = tree.filter(f => f.type === "blob").slice(0, 80);
    const keyFiles = ["Dockerfile","docker-compose.yml","Cargo.toml","package.json","requirements.txt","build.gradle","nginx.conf","Makefile",".github/workflows"];
    const highlighted = displayFiles.filter(f => keyFiles.some(k => f.path.includes(k)));
    const others = displayFiles.filter(f => !keyFiles.some(k => f.path.includes(k)));

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => { setView("repos"); setSelectedRepo(null); }} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 7, padding: "6px 12px", color: "#60a5fa", cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}>← Repos</button>
          <span style={{ fontFamily: "monospace", fontSize: 13, color: "#f1f5f9", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedRepo.name}</span>
        </div>

        {/* Branch selector */}
        {branches.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#475569" }}>⎇</span>
            <select value={activeBranch} onChange={e => switchBranch(e.target.value)} style={{ flex: 1, background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 6, padding: "8px 10px", color: "#e2e8f0", fontSize: 12, fontFamily: "monospace" }}>
              {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>
        )}

        {/* Import to environment */}
        <TBtn variant="success" full onClick={() => importToEnv(selectedRepo)}>
          ＋ Import to Environment
        </TBtn>

        {loading && <div style={{ fontSize: 12, color: "#f59e0b", fontFamily: "monospace" }}>⟳ {loading}</div>}
        {error && <div style={{ fontSize: 12, color: "#f87171", fontFamily: "monospace", background: "#1c0a0a", padding: "8px 12px", borderRadius: 7 }}>⚠ {error}</div>}

        {/* Key config files */}
        {highlighted.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Config Files</div>
            {highlighted.map(f => (
              <button key={f.path} onClick={() => viewFile(f.path)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "#050a0f", border: "1px solid #1e3a5f", borderRadius: 7, padding: "9px 12px", marginBottom: 5, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
                <span style={{ fontSize: 14 }}>{f.path.includes("Dockerfile") ? "🐳" : f.path.includes("Cargo") ? "🦀" : f.path.includes("package.json") ? "⬡" : f.path.includes("requirements") ? "🐍" : f.path.includes("gradle") ? "🤖" : "📄"}</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#7dd3fc", flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                <span style={{ fontSize: 10, color: "#334155" }}>→</span>
              </button>
            ))}
          </div>
        )}

        {/* Recent commits */}
        {commits.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Recent Commits</div>
            {commits.slice(0, 8).map(c => {
              const sha = c.sha.slice(0, 7);
              const msg = c.commit.message.split("\n")[0].slice(0, 60);
              const author = c.commit.author.name;
              const date = new Date(c.commit.author.date).toLocaleDateString();
              return (
                <div key={c.sha} style={{ background: "#050a0f", border: "1px solid #0f172a", borderRadius: 7, padding: "9px 12px", marginBottom: 5 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                    <code style={{ fontSize: 10, color: "#f59e0b", background: "#1c1400", padding: "1px 5px", borderRadius: 3 }}>{sha}</code>
                    <span style={{ fontSize: 11, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#334155" }}>{author} · {date}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* All files tree */}
        {others.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Files ({displayFiles.length})</div>
            <div style={{ background: "#050a0f", border: "1px solid #0f172a", borderRadius: 8, overflow: "hidden" }}>
              {others.slice(0, 40).map((f, i) => (
                <button key={f.path} onClick={() => viewFile(f.path)} style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  background: "transparent", border: "none",
                  borderBottom: i < others.length - 1 ? "1px solid #0a0f1a" : "none",
                  padding: "9px 12px", cursor: "pointer", WebkitTapHighlightColor: "transparent",
                }}>
                  <span style={{ fontSize: 11 }}>📄</span>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Repo list ──
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* User header */}
      <div style={{ background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
        {ghUser?.avatar_url && (
          <img src={ghUser.avatar_url} alt="avatar" style={{ width: 40, height: 40, borderRadius: "50%", border: "2px solid #1e3a5f" }} />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>{ghUser?.name ?? ghUser?.login}</div>
          <div style={{ fontSize: 11, color: "#475569" }}>@{ghUser?.login} · {ghUser?.public_repos} repos</div>
        </div>
        <button onClick={disconnect} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 7, padding: "5px 10px", color: "#ef4444", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>Disconnect</button>
      </div>

      {loading && <div style={{ fontSize: 12, color: "#f59e0b", fontFamily: "monospace" }}>⟳ {loading}</div>}
      {error && <div style={{ fontSize: 12, color: "#f87171", fontFamily: "monospace", background: "#1c0a0a", padding: "8px 12px", borderRadius: 7 }}>⚠ {error}</div>}

      <div style={{ fontSize: 11, color: "#475569", letterSpacing: 1, textTransform: "uppercase" }}>
        Repositories ({repos.length})
      </div>

      {repos.map(repo => {
        const langColor = LANG_COLORS[repo.language] ?? "#64748b";
        const envType = detectEnvType(repo.language);
        const envInfo = ENV_TYPES[envType];
        return (
          <div key={repo.id} style={{ background: "#050a0f", border: "1px solid #0f172a", borderRadius: 10, overflow: "hidden" }}>
            <button onClick={() => openRepo(repo)} style={{ display: "flex", alignItems: "flex-start", gap: 12, width: "100%", background: "transparent", border: "none", padding: "12px 14px", cursor: "pointer", WebkitTapHighlightColor: "transparent", textAlign: "left" }}>
              <span style={{ fontSize: 18, marginTop: 2 }}>{envInfo.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 13, color: "#f1f5f9", fontWeight: 600 }}>{repo.name}</span>
                  {repo.private && <Tag color="#f59e0b">PRIVATE</Tag>}
                  <Tag color={langColor}>{repo.language ?? "—"}</Tag>
                </div>
                {repo.description && (
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo.description}</div>
                )}
                <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#334155" }}>
                  <span>⎇ {repo.default_branch}</span>
                  <span>★ {repo.stargazers_count}</span>
                  <span>{new Date(repo.pushed_at).toLocaleDateString()}</span>
                </div>
              </div>
              <span style={{ color: "#334155", fontSize: 14, marginTop: 2 }}>›</span>
            </button>
            <div style={{ borderTop: "1px solid #0a0f1a", padding: "8px 14px", display: "flex", gap: 7 }}>
              <TBtn variant="success" small onClick={e => { e.stopPropagation(); importToEnv(repo); }} style={{ fontSize: 11, minHeight: 34, flex: 1 }}>
                ＋ Import
              </TBtn>
              <TBtn variant="ghost" small onClick={e => { e.stopPropagation(); openRepo(repo); }} style={{ fontSize: 11, minHeight: 34, flex: 1 }}>
                Browse →
              </TBtn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ADD ENV MODAL
// ─────────────────────────────────────────────────────────────
function AddEnvSheet({ open, onAdd, onClose }) {
  const [form, setForm] = useState({ name: "", type: "docker", port: "", branch: "main", rustTarget: "x86_64-unknown-linux-gnu" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const inputStyle = {
    width: "100%", background: "#0a0f1a", border: "1px solid #1e293b",
    borderRadius: 8, padding: "12px 14px", color: "#e2e8f0",
    fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box",
  };
  const labelStyle = { fontSize: 11, color: "#475569", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6, display: "block" };

  return (
    <SlideSheet open={open} onClose={onClose} title="New Environment" fullHeight>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <span style={labelStyle}>Name</span>
          <input style={inputStyle} value={form.name} onChange={e => set("name", e.target.value)} placeholder="my-service" />
        </div>

        <div>
          <span style={labelStyle}>Type</span>
          <select value={form.type} onChange={e => set("type", e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
            {Object.entries(ENV_TYPES).map(([k, v]) => (
              <option key={k} value={k}>{v.icon} {v.label} — {v.desc}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <span style={labelStyle}>Port</span>
            <input style={inputStyle} value={form.port} onChange={e => set("port", e.target.value)} placeholder="3000" type="number" />
          </div>
          <div>
            <span style={labelStyle}>Branch</span>
            <input style={inputStyle} value={form.branch} onChange={e => set("branch", e.target.value)} placeholder="main" />
          </div>
        </div>

        {form.type === "rust" && (
          <div>
            <span style={labelStyle}>Rust Target Triple</span>
            <select value={form.rustTarget} onChange={e => set("rustTarget", e.target.value)} style={{ ...inputStyle, cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}>
              {["x86_64-unknown-linux-gnu","aarch64-unknown-linux-gnu","x86_64-pc-windows-gnu","aarch64-apple-darwin","x86_64-apple-darwin","wasm32-unknown-unknown","armv7-unknown-linux-gnueabihf"].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ paddingTop: 8 }}>
          <TBtn variant="primary" full onClick={() => {
            if (!form.name.trim()) return;
            onAdd({ id: `e-${Date.now()}`, name: form.name.toLowerCase().replace(/\s+/g, "-"), type: form.type, status: "idle", port: form.port ? parseInt(form.port) : null, branch: form.branch || "main", health: 0, lastDeploy: "never", logs: [], rustTarget: form.rustTarget });
            setForm({ name: "", type: "docker", port: "", branch: "main", rustTarget: "x86_64-unknown-linux-gnu" });
            onClose();
          }}>Create Environment</TBtn>
        </div>
      </div>
    </SlideSheet>
  );
}

// ─────────────────────────────────────────────────────────────
// BOTTOM TAB BAR (phone-only)
// ─────────────────────────────────────────────────────────────
function BottomTabBar({ active, onSelect }) {
  return (
    <div style={{
      display: "flex", background: "#050a0f",
      borderTop: "1px solid #0a0f1a",
      paddingBottom: "env(safe-area-inset-bottom, 4px)",
      flexShrink: 0,
    }}>
      {BOTTOM_TABS.map(tab => {
        const isActive = active === tab.id;
        return (
          <button key={tab.id} onClick={() => onSelect(tab.id)} style={{
            flex: 1, padding: "10px 4px 8px", cursor: "pointer",
            background: "transparent", border: "none",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            color: isActive ? "#60a5fa" : "#334155",
            WebkitTapHighlightColor: "transparent",
            transition: "color 0.15s",
            minHeight: 56,
          }}>
            <span style={{ fontSize: 20 }}>{tab.icon}</span>
            <span style={{ fontSize: 9, letterSpacing: 0.5, fontWeight: isActive ? 600 : 400 }}>
              {tab.label.toUpperCase()}
            </span>
            {isActive && <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#60a5fa" }} />}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────
function App() {
  const bp = useBreakpoint(); // "phone" | "fold" | "wide"
  const isPhone = bp === "phone";
  const isFold  = bp === "fold";
  const isWide  = bp === "wide";

  // AI state
  const [activeBackend, setActiveBackend] = useState("claude");
  const [activeModel, setActiveModel] = useState("claude-sonnet-4-20250514");
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  // GitHub OAuth state — token kept in memory only, never persisted
  const [ghToken,    setGhToken]    = useState(null);
  const [ghSettings, setGhSettings] = useState({ ghClientId: "", cfWorkerUrl: "", webhookSecret: "" });

  // Chat state
  const [messages, setMessages] = useState([{
    id: "welcome", role: "assistant", rawText: "",
    blocks: [{ type: "text", content: `**DevOps AI Platform** 🚀\n\nI automate deployment for:\n🐳 **Docker**  •  🤖 **Android**  •  🦀 **Rust**  •  🐍 **Python**  •  ⬡ **Node.js**  •  🔧 **Compose**  •  ⚡ **Static**\n\nTry:\n- \`deploy docker app port 3000\`\n- \`build android apk\`\n- \`setup rust for aarch64\`\n- \`show all environments\`` }],
    streaming: false,
  }]);
  const [input, setInput] = useState("");
  const [deployLogs, setDeployLogs] = useState({});
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // Environments
  const [environments, dispatch] = useReducer(envsReducer, INITIAL_ENVS);
  const [activeDeployId, setActiveDeployId] = useState(null);

  // Phone navigation
  const [activeTab, setActiveTab] = useState("chat");
  const [showAddEnv, setShowAddEnv] = useState(false);
  const [showSettingsSheet, setShowSettingsSheet] = useState(false);

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Switch to chat tab when AI responds (mobile)
  useEffect(() => {
    if (aiLoading && isPhone) setActiveTab("chat");
  }, [aiLoading, isPhone]);

  // ── Deploy ──────────────────────────────────
  const handleDeploy = useCallback((envId) => {
    const env = environments.find(e => e.id === envId);
    if (!env || activeDeployId) return;
    setActiveDeployId(envId);
    if (isPhone) setActiveTab("chat");

    const termId = `term-${Date.now()}`;
    const initLines = [`[${new Date().toLocaleTimeString()}] ▶ Starting ${env.type} deployment: ${env.name}`];
    setDeployLogs(prev => ({ ...prev, [envId]: initLines }));
    setMessages(prev => [...prev, {
      id: termId, role: "assistant", rawText: "",
      blocks: [{ type: "terminal", lines: initLines, height: 200, title: `deploy: ${env.name}` }],
      streaming: false,
    }]);

    runDeployment(env, dispatch,
      (line) => {
        setDeployLogs(prev => {
          const updated = [...(prev[envId] ?? []), line];
          setMessages(msgs => msgs.map(m => m.id === termId ? { ...m, blocks: [{ ...m.blocks[0], lines: updated }] } : m));
          return { ...prev, [envId]: updated };
        });
      },
      () => {
        setActiveDeployId(null);
        setMessages(prev => [...prev, { id: `done-${Date.now()}`, role: "system_event", content: `✓ ${env.name} deployed successfully` }]);
      }
    );
  }, [environments, activeDeployId, isPhone]);

  const handleStop = useCallback((envId) => {
    const env = environments.find(e => e.id === envId);
    if (!env) return;
    dispatch({ type: "UPDATE", id: envId, patch: { status: "stopped", health: 0 } });
    dispatch({ type: "LOG", id: envId, line: `[${new Date().toLocaleTimeString()}] Environment stopped` });
    setMessages(prev => [...prev, { id: `stop-${Date.now()}`, role: "system_event", content: `■ ${env.name} stopped` }]);
  }, [environments]);

  // ── Action proposals ────────────────────────
  const handleConfirmAction = useCallback((msgId, blockId, proposal) => {
    setMessages(msgs => msgs.map(m => m.id === msgId ? { ...m, proposalStates: { ...(m.proposalStates ?? {}), [blockId]: { confirmed: true, executing: true } } } : m));

    const envName = proposal.envName ?? "new-environment";
    let env = environments.find(e => e.name === envName);
    if (!env) {
      env = { id: `e-${Date.now()}`, name: envName, type: proposal.envType ?? "docker", status: "idle", port: proposal.port ?? 3000, branch: "main", health: 0, lastDeploy: "never", logs: [] };
      dispatch({ type: "ADD", env });
    }

    setTimeout(() => {
      if (["DEPLOY","BUILD","SETUP"].includes(proposal.action)) handleDeploy(env.id);
      setMessages(msgs => msgs.map(m => m.id === msgId ? { ...m, proposalStates: { ...(m.proposalStates ?? {}), [blockId]: { confirmed: true, executing: false, done: true } } } : m));
    }, 800);
  }, [environments, handleDeploy]);

  const handleDismissAction = useCallback((msgId, blockId) => {
    setMessages(msgs => msgs.map(m => m.id === msgId ? { ...m, proposalStates: { ...(m.proposalStates ?? {}), [blockId]: { dismissed: true } } } : m));
  }, []);

  // ── GitHub import ───────────────────────────
  const handleImportFromGitHub = useCallback(({ name, type, branch, githubUrl, fullName }) => {
    const existing = environments.find(e => e.name === name);
    if (existing) {
      setMessages(prev => [...prev, { id: `gh-${Date.now()}`, role: "system_event", content: `⚠ Environment "${name}" already exists` }]);
      if (isPhone) setActiveTab("chat");
      return;
    }
    const newEnv = {
      id: `e-${Date.now()}`,
      name,
      type,
      status: "idle",
      port: type === "python" ? 5000 : type === "android" || type === "rust" ? null : 3000,
      branch,
      health: 0,
      lastDeploy: "never",
      logs: [`[${new Date().toLocaleTimeString()}] Imported from GitHub: ${fullName}`],
      githubUrl,
      githubFullName: fullName,
    };
    dispatch({ type: "ADD", env: newEnv });
    setMessages(prev => [...prev, {
      id: `gh-${Date.now()}`, role: "assistant", rawText: "",
      blocks: [{ type: "text", content: `🐙 **Imported from GitHub**\n\nCreated **${name}** (${ENV_TYPES[type]?.icon} ${ENV_TYPES[type]?.label}) from \`${fullName}\` on branch \`${branch}\`.\n\nRun: \`deploy ${name}\` to start the deployment pipeline.` }],
      streaming: false,
    }]);
    if (isPhone) setActiveTab("chat");
  }, [environments, isPhone]);

  // ── GitHub webhook auto-deploy trigger ──────────────────────
  const handleAutoDeployTrigger = useCallback((repoFullName, event) => {
    const env = environments.find(e => e.githubFullName === repoFullName);
    if (!env) return;
    setMessages(prev => [...prev, {
      id: `wh-${Date.now()}`, role: "system_event",
      content: `🔔 ${event.label} → auto-deploying ${env.name}`,
    }]);
    handleDeploy(env.id);
  }, [environments, handleDeploy]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || aiLoading) return;
    setInput("");
    if (isPhone) setActiveTab("chat");

    const userMsg = { id: `u-${Date.now()}`, role: "user", content: text, rawText: text };
    setMessages(prev => [...prev, userMsg]);
    setAiLoading(true);

    const { action } = parseIntent(text);
    if (action === "LIST") {
      setMessages(prev => [...prev, {
        id: `a-${Date.now()}`, role: "assistant", rawText: "",
        blocks: [{ type: "text", content: `Here are all **${environments.length} environments**:` }, { type: "env_list_request" }],
        streaming: false,
      }]);
      setAiLoading(false);
      return;
    }

    const assistantId = `a-${Date.now()}`;
    setMessages(prev => [...prev, { id: assistantId, role: "assistant", rawText: "", blocks: [], streaming: true }]);

    try {
      const history = messages.slice(-12).concat(userMsg)
        .map(m => ({ role: m.role === "system_event" ? "assistant" : m.role, content: m.rawText ?? m.content ?? "" }))
        .filter(m => m.content && (m.role === "user" || m.role === "assistant"));

      let rawText = "";
      await callAI(activeBackend, activeModel, history, openrouterKey, (chunk) => {
        rawText = chunk;
        setMessages(msgs => msgs.map(m => m.id === assistantId ? { ...m, rawText: chunk, blocks: [{ type: "text", content: chunk }], streaming: true } : m));
      });

      const blocks = parseAIResponse(rawText);
      setMessages(msgs => msgs.map(m => m.id === assistantId ? { ...m, rawText, blocks, streaming: false, proposalStates: {} } : m));
    } catch (err) {
      setMessages(msgs => msgs.map(m => m.id === assistantId ? {
        ...m, rawText: "",
        blocks: [{ type: "text", content: `⚠️ **${err.message}**\n\nOpen ⚙ Settings to configure your AI backend.` }],
        streaming: false,
      } : m));
    } finally {
      setAiLoading(false);
    }
  }, [input, aiLoading, messages, activeBackend, activeModel, openrouterKey, environments, isPhone]);

  const backend = AI_BACKENDS[activeBackend];

  // ─────────────────────────────────────────────
  // HEADER
  // ─────────────────────────────────────────────
  const Header = () => (
    <div style={{
      height: isPhone ? 52 : 50,
      background: "#050a0f", borderBottom: "1px solid #0a0f1a",
      display: "flex", alignItems: "center",
      padding: isPhone ? "0 14px" : "0 18px", gap: 10, flexShrink: 0,
      paddingTop: "env(safe-area-inset-top, 0px)",
    }}>
      {/* Logo */}
      <div style={{
        width: 32, height: 32, borderRadius: 9,
        background: "linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
        flexShrink: 0,
      }}>⚙</div>

      {!isPhone && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.4, lineHeight: 1 }}>
            DevOps<span style={{ color: "#3b82f6" }}>AI</span>
          </div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: 2 }}>PLATFORM</div>
        </div>
      )}

      {isPhone && (
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: -0.4 }}>
          DevOps<span style={{ color: "#3b82f6" }}>AI</span>
        </div>
      )}

      {/* Backend status */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, background: `${backend.color}12`, border: `1px solid ${backend.color}30`, borderRadius: 20, padding: "3px 10px" }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: backend.color, boxShadow: `0 0 6px ${backend.color}` }} />
        <span style={{ fontSize: 11, color: backend.color, fontFamily: "monospace", fontWeight: 600 }}>{backend.shortLabel}</span>
      </div>

      {/* Backend switcher (hide on very narrow) */}
      {!isPhone && (
        <div style={{ display: "flex", gap: 4 }}>
          {Object.values(AI_BACKENDS).map(b => (
            <button key={b.id} onClick={() => { setActiveBackend(b.id); setActiveModel(b.models[0]); }} style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 10, cursor: "pointer",
              fontFamily: "monospace", letterSpacing: 0.5, fontWeight: 600,
              background: activeBackend === b.id ? `${b.color}15` : "transparent",
              color: activeBackend === b.id ? b.color : "#334155",
              border: `1px solid ${activeBackend === b.id ? b.color + "55" : "#1e293b"}`,
            }}>{b.shortLabel}</button>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Settings button */}
      <button onClick={() => setShowSettingsSheet(true)} style={{
        width: 36, height: 36, borderRadius: 9,
        background: "#0f172a", border: "1px solid #1e293b",
        color: "#64748b", cursor: "pointer", fontSize: 16,
        display: "flex", alignItems: "center", justifyContent: "center",
        WebkitTapHighlightColor: "transparent",
      }}>⚙</button>
    </div>
  );

  // ─────────────────────────────────────────────
  // CHAT VIEW
  // ─────────────────────────────────────────────
  const ChatView = () => (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Messages */}
      <div style={{
        flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch",
        padding: isPhone ? "14px 14px 8px" : "20px 22px 8px",
        display: "flex", flexDirection: "column",
      }}>
        {messages.map(msg => (
          <ChatMessage key={msg.id} msg={msg}
            environments={environments} onDeploy={handleDeploy} onStop={handleStop}
            onConfirmAction={handleConfirmAction} onDismissAction={handleDismissAction}
          />
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Quick prompts — horizontal scroll on phone */}
      <div style={{
        padding: isPhone ? "8px 12px 0" : "8px 22px 0",
        borderTop: "1px solid #0a0f1a", overflowX: "auto", flexShrink: 0,
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none", msOverflowStyle: "none",
      }}>
        <div style={{ display: "flex", gap: 7, paddingBottom: 2, minWidth: "max-content" }}>
          {[
            "deploy docker port 3000",
            "build android apk",
            "setup rust aarch64",
            "deploy python api",
            "show all environments",
            "debug node app",
          ].map(p => (
            <button key={p} onClick={() => { setInput(p); inputRef.current?.focus(); }} style={{
              padding: "6px 12px", borderRadius: 20, fontSize: 11,
              background: "#0a0f1a", color: "#475569",
              border: "1px solid #1e293b", cursor: "pointer",
              fontFamily: "inherit", whiteSpace: "nowrap",
              minHeight: 32, WebkitTapHighlightColor: "transparent",
            }}>{p}</button>
          ))}
        </div>
      </div>

      {/* Input bar */}
      <div style={{
        padding: isPhone ? "10px 12px 10px" : "12px 22px 14px",
        paddingBottom: isPhone ? "calc(10px + env(safe-area-inset-bottom, 0px))" : "14px",
        display: "flex", gap: 8, alignItems: "flex-end", flexShrink: 0,
      }}>
        <div style={{ flex: 1, position: "relative" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder={`Message ${backend.label}…`}
            rows={1}
            style={{
              width: "100%", background: "#080e18",
              border: `1px solid ${input ? "#1e3a5f" : "#0f172a"}`,
              borderRadius: 12, padding: "12px 52px 12px 16px",
              color: "#e2e8f0", fontSize: isPhone ? 16 : 14,
              fontFamily: "inherit", outline: "none", resize: "none", lineHeight: 1.5,
              WebkitAppearance: "none",
            }}
          />
          <button onClick={sendMessage} disabled={!input.trim() || aiLoading} style={{
            position: "absolute", right: 8, bottom: 8,
            width: 36, height: 36, borderRadius: 9,
            background: input.trim() && !aiLoading ? "#1d4ed8" : "#0f172a",
            color: input.trim() && !aiLoading ? "#fff" : "#334155",
            border: "none", cursor: input.trim() && !aiLoading ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, WebkitTapHighlightColor: "transparent",
          }}>
            {aiLoading
              ? <span style={{ animation: "spin 0.8s linear infinite", display: "inline-block" }}>⟳</span>
              : "↑"}
          </button>
        </div>
      </div>
    </div>
  );

  // ─────────────────────────────────────────────
  // LAYOUT: PHONE — bottom tabs
  // ─────────────────────────────────────────────
  if (isPhone) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#020408", color: "#e2e8f0", fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden" }}>
        <style>{`
          @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:0} }
          @keyframes gpulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
          @keyframes spin    { from{transform:rotate(0)} to{transform:rotate(360deg)} }
          @keyframes slideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
          @keyframes fadeIn  { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
          * { box-sizing: border-box; }
          ::-webkit-scrollbar { display: none; }
          textarea { -webkit-text-size-adjust: 100%; font-size: 16px !important; }
          input, select { -webkit-appearance: none; }
        `}</style>

        <Header />

        {/* Content area */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {activeTab === "chat"     && <ChatView />}
          {activeTab === "envs"     && (
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px", WebkitOverflowScrolling: "touch" }}>
              <EnvsPanel environments={environments} onDeploy={handleDeploy} onStop={handleStop} onAddEnv={() => setShowAddEnv(true)} deployLogs={deployLogs} />
            </div>
          )}
          {activeTab === "github"   && (
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px", WebkitOverflowScrolling: "touch" }}>
              <GitHubPanel onImportToEnv={handleImportFromGitHub} ghSettings={ghSettings} ghToken={ghToken} setGhToken={setGhToken} onAutoDeployTrigger={handleAutoDeployTrigger} />
            </div>
          )}
          {activeTab === "terminal" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px", WebkitOverflowScrolling: "touch" }}>
              <LogsPanel environments={environments} deployLogs={deployLogs} />
            </div>
          )}
          {activeTab === "settings" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px 8px", WebkitOverflowScrolling: "touch" }}>
              <SettingsPanel activeBackend={activeBackend} setActiveBackend={setActiveBackend} activeModel={activeModel} setActiveModel={setActiveModel} openrouterKey={openrouterKey} setOpenrouterKey={setOpenrouterKey} ghSettings={ghSettings} setGhSettings={setGhSettings} />
            </div>
          )}
        </div>

        <BottomTabBar active={activeTab} onSelect={setActiveTab} />

        {/* Sheets */}
        <AddEnvSheet open={showAddEnv} onAdd={env => dispatch({ type: "ADD", env })} onClose={() => setShowAddEnv(false)} />
        <SlideSheet open={showSettingsSheet} onClose={() => setShowSettingsSheet(false)} title="Settings" fullHeight>
          <SettingsPanel activeBackend={activeBackend} setActiveBackend={b => { setActiveBackend(b); setActiveModel(AI_BACKENDS[b].models[0]); }} activeModel={activeModel} setActiveModel={setActiveModel} openrouterKey={openrouterKey} setOpenrouterKey={setOpenrouterKey} ghSettings={ghSettings} setGhSettings={setGhSettings} />
        </SlideSheet>
      </div>
    );
  }

  // ─────────────────────────────────────────────
  // LAYOUT: FOLD OPEN — side-by-side split
  // 55% chat | 45% envs panel
  // ─────────────────────────────────────────────
  if (isFold) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#020408", color: "#e2e8f0", fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden" }}>
        <style>{`
          @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:0} }
          @keyframes gpulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
          @keyframes spin    { from{transform:rotate(0)} to{transform:rotate(360deg)} }
          @keyframes slideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
          @keyframes fadeIn  { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
          * { box-sizing: border-box; }
          ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-track { background: #0f172a; } ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        `}</style>

        <Header />

        {/* Split layout */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Chat — left 55% */}
          <div style={{ width: "55%", display: "flex", flexDirection: "column", overflow: "hidden", borderRight: "1px solid #0a0f1a" }}>
            <ChatView />
          </div>

          {/* Right panel — tabbed */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Mini tab row */}
            <div style={{ display: "flex", borderBottom: "1px solid #0a0f1a", flexShrink: 0, overflowX: "auto" }}>
              {[{ id: "envs", label: "Environments" }, { id: "github", label: "🐙 GitHub" }, { id: "terminal", label: "Logs" }, { id: "settings", label: "Settings" }].map(t => (
                <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                  flex: 1, padding: "10px 8px", background: activeTab === t.id ? "#0f172a" : "transparent",
                  color: activeTab === t.id ? "#e2e8f0" : "#475569",
                  border: "none", borderBottom: `2px solid ${activeTab === t.id ? "#3b82f6" : "transparent"}`,
                  cursor: "pointer", fontSize: 11, fontFamily: "inherit", whiteSpace: "nowrap",
                  WebkitTapHighlightColor: "transparent",
                }}>{t.label}</button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", WebkitOverflowScrolling: "touch" }}>
              {activeTab === "envs"     && <EnvsPanel environments={environments} onDeploy={handleDeploy} onStop={handleStop} onAddEnv={() => setShowAddEnv(true)} deployLogs={deployLogs} />}
              {activeTab === "github"   && <GitHubPanel onImportToEnv={handleImportFromGitHub} ghSettings={ghSettings} ghToken={ghToken} setGhToken={setGhToken} onAutoDeployTrigger={handleAutoDeployTrigger} />}
              {activeTab === "terminal" && <LogsPanel environments={environments} deployLogs={deployLogs} />}
              {activeTab === "settings" && <SettingsPanel activeBackend={activeBackend} setActiveBackend={b => { setActiveBackend(b); setActiveModel(AI_BACKENDS[b].models[0]); }} activeModel={activeModel} setActiveModel={setActiveModel} openrouterKey={openrouterKey} setOpenrouterKey={setOpenrouterKey} ghSettings={ghSettings} setGhSettings={setGhSettings} />}
            </div>
          </div>
        </div>

        <AddEnvSheet open={showAddEnv} onAdd={env => dispatch({ type: "ADD", env })} onClose={() => setShowAddEnv(false)} />
        <SlideSheet open={showSettingsSheet} onClose={() => setShowSettingsSheet(false)} title="Settings" fullHeight>
          <SettingsPanel activeBackend={activeBackend} setActiveBackend={b => { setActiveBackend(b); setActiveModel(AI_BACKENDS[b].models[0]); }} activeModel={activeModel} setActiveModel={setActiveModel} openrouterKey={openrouterKey} setOpenrouterKey={setOpenrouterKey} ghSettings={ghSettings} setGhSettings={setGhSettings} />
        </SlideSheet>
      </div>
    );
  }

  // ─────────────────────────────────────────────
  // LAYOUT: WIDE — desktop (original sidebar)
  // ─────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#020408", color: "#e2e8f0", fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden" }}>
      <style>{`
        @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes gpulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes spin    { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        @keyframes slideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes fadeIn  { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-track { background: #0f172a; } ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        button:active { opacity: 0.8; }
      `}</style>

      <Header />

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Chat — primary */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <ChatView />
        </div>

        {/* Sidebar — tabs */}
        <div style={{ width: 300, display: "flex", flexDirection: "column", borderLeft: "1px solid #0a0f1a", background: "#050a0f", overflow: "hidden" }}>
          <div style={{ display: "flex", borderBottom: "1px solid #0a0f1a", flexShrink: 0 }}>
            {[{ id: "envs", label: "Envs" }, { id: "github", label: "🐙" }, { id: "terminal", label: "Logs" }, { id: "settings", label: "Config" }].map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                flex: 1, padding: "10px 4px", background: activeTab === t.id ? "#0f172a" : "transparent",
                color: activeTab === t.id ? "#e2e8f0" : "#475569",
                border: "none", borderBottom: `2px solid ${activeTab === t.id ? "#3b82f6" : "transparent"}`,
                cursor: "pointer", fontSize: 11, fontFamily: "inherit",
              }}>{t.label}</button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px" }}>
            {activeTab === "envs"     && <EnvsPanel environments={environments} onDeploy={handleDeploy} onStop={handleStop} onAddEnv={() => setShowAddEnv(true)} deployLogs={deployLogs} />}
            {activeTab === "github"   && <GitHubPanel onImportToEnv={handleImportFromGitHub} ghSettings={ghSettings} ghToken={ghToken} setGhToken={setGhToken} onAutoDeployTrigger={handleAutoDeployTrigger} />}
            {activeTab === "terminal" && <LogsPanel environments={environments} deployLogs={deployLogs} />}
            {activeTab === "settings" && <SettingsPanel activeBackend={activeBackend} setActiveBackend={b => { setActiveBackend(b); setActiveModel(AI_BACKENDS[b].models[0]); }} activeModel={activeModel} setActiveModel={setActiveModel} openrouterKey={openrouterKey} setOpenrouterKey={setOpenrouterKey} ghSettings={ghSettings} setGhSettings={setGhSettings} />}
          </div>
        </div>
      </div>

      <AddEnvSheet open={showAddEnv} onAdd={env => dispatch({ type: "ADD", env })} onClose={() => setShowAddEnv(false)} />
      <SlideSheet open={showSettingsSheet} onClose={() => setShowSettingsSheet(false)} title="Settings" fullHeight>
        <SettingsPanel activeBackend={activeBackend} setActiveBackend={b => { setActiveBackend(b); setActiveModel(AI_BACKENDS[b].models[0]); }} activeModel={activeModel} setActiveModel={setActiveModel} openrouterKey={openrouterKey} setOpenrouterKey={setOpenrouterKey} ghSettings={ghSettings} setGhSettings={setGhSettings} />
      </SlideSheet>
    </div>
  );
}