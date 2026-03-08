/**
 * DevOps AI Platform — Cloudflare Worker
 *
 * Handles three things that a browser PWA cannot do directly:
 *   1. GitHub OAuth token exchange  (POST /oauth/token)
 *   2. Webhook receiver             (POST /webhook)
 *   3. Webhook event polling        (GET  /webhook/events)
 *
 * Deploy:
 *   1. wrangler.toml (see bottom of this file) OR paste into CF Dashboard
 *   2. Set env vars:  CLIENT_ID, CLIENT_SECRET, WEBHOOK_SECRET (optional)
 *   3. Create KV namespace "EVENTS", bind it in wrangler.toml
 *
 * Free tier: 100k requests/day, 1 GB KV storage — plenty for personal use.
 */

// ── CORS headers returned on every response ──────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-GitHub-Event,X-Hub-Signature-256",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const text = (body, status = 200) =>
  new Response(body, { status, headers: CORS });

// ── HMAC-SHA256 webhook signature verification ────────────────────────────────
async function verifyWebhookSignature(request, secret, rawBody) {
  if (!secret) return true; // skip if no secret configured
  const sig = request.headers.get("X-Hub-Signature-256") ?? "";
  if (!sig.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expectedHex = "sha256=" + Array.from(new Uint8Array(expected))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  // Constant-time comparison
  if (expectedHex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") return text("", 204);

    // ── 1. OAuth token exchange ──────────────────────────────────────────────
    // Called by PWA after GitHub redirects back with ?code=...
    // Browser cannot do this directly — GitHub blocks CORS on token endpoint.
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const { code, redirect_uri } = await request.json().catch(() => ({}));
      if (!code) return json({ error: "missing_code" }, 400);

      const ghRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id:     env.CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
          code,
          redirect_uri,
        }),
      });

      const data = await ghRes.json();

      if (data.error) return json({ error: data.error, description: data.error_description }, 400);
      if (!data.access_token) return json({ error: "no_token_in_response" }, 502);

      // Return token — PWA stores this in memory only (never sessionStorage/localStorage)
      return json({ access_token: data.access_token, scope: data.scope, token_type: data.token_type });
    }

    // ── 2. Webhook receiver ──────────────────────────────────────────────────
    // GitHub POSTs here on push / pull_request / deployment_status events.
    // We verify signature, extract key fields, store in KV for the PWA to poll.
    if (url.pathname === "/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const event   = request.headers.get("X-GitHub-Event") ?? "unknown";
      const deliveryId = request.headers.get("X-GitHub-Delivery") ?? crypto.randomUUID();

      // Verify signature if secret is configured
      const valid = await verifyWebhookSignature(request, env.WEBHOOK_SECRET, rawBody);
      if (!valid) return text("Forbidden", 403);

      let payload;
      try { payload = JSON.parse(rawBody); } catch { return text("Bad JSON", 400); }

      const repo = payload.repository?.full_name;
      if (!repo) return text("ok (no repo)", 200); // ping events etc.

      // Build a compact summary for the PWA
      const summary = buildEventSummary(event, payload);
      const record = {
        id:        deliveryId,
        event,
        repo,
        summary,
        ts:        Date.now(),
      };

      // Store per-repo, keep rolling list of last 20 events
      // KV key: "events:{owner/repo}"
      const kvKey = `events:${repo}`;
      let existing = [];
      try {
        const stored = await env.EVENTS.get(kvKey, "json");
        if (Array.isArray(stored)) existing = stored;
      } catch {}

      existing.unshift(record);
      await env.EVENTS.put(kvKey, JSON.stringify(existing.slice(0, 20)), {
        expirationTtl: 86400, // auto-expire after 24h
      });

      return text("ok");
    }

    // ── 3. Webhook event polling ─────────────────────────────────────────────
    // PWA calls GET /webhook/events?repo=owner/repo&since=1234567890
    // Returns new events since the given timestamp.
    if (url.pathname === "/webhook/events" && request.method === "GET") {
      const repo  = url.searchParams.get("repo");
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);

      if (!repo) return json({ error: "missing repo param" }, 400);

      let events = [];
      try {
        const stored = await env.EVENTS.get(`events:${repo}`, "json");
        if (Array.isArray(stored)) {
          events = stored.filter(e => e.ts > since);
        }
      } catch {}

      return json({ repo, events, polledAt: Date.now() });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        name:    "DevOps AI Platform — CF Worker",
        version: "1.0.0",
        endpoints: ["/oauth/token", "/webhook", "/webhook/events"],
        status:  "ok",
      });
    }

    return text("Not found", 404);
  },
};

// ── Event summary builder ─────────────────────────────────────────────────────
function buildEventSummary(event, payload) {
  if (event === "push") {
    const branch  = payload.ref?.replace("refs/heads/", "") ?? "unknown";
    const commits = payload.commits ?? [];
    const message = commits[0]?.message?.split("\n")[0]?.slice(0, 72) ?? "";
    const pusher  = payload.pusher?.name ?? "unknown";
    return { event, branch, commits: commits.length, message, pusher };
  }

  if (event === "pull_request") {
    const pr = payload.pull_request ?? {};
    return {
      event,
      action:  payload.action,
      number:  payload.number,
      title:   pr.title?.slice(0, 72) ?? "",
      branch:  pr.head?.ref ?? "",
      merged:  pr.merged === true,
      author:  pr.user?.login ?? "unknown",
    };
  }

  if (event === "deployment_status") {
    return {
      event,
      state:       payload.deployment_status?.state,
      environment: payload.deployment?.environment ?? "unknown",
      description: payload.deployment_status?.description?.slice(0, 72) ?? "",
    };
  }

  // Ping and everything else
  return { event, zen: payload.zen };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * wrangler.toml (put this in a separate file, NOT in this JS file)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * name = "devopsai-proxy"
 * main = "cf-worker.js"
 * compatibility_date = "2024-09-01"
 *
 * [[kv_namespaces]]
 * binding = "EVENTS"
 * id      = "YOUR_KV_NAMESPACE_ID"
 *
 * [vars]
 * CLIENT_ID = "YOUR_GITHUB_OAUTH_APP_CLIENT_ID"
 *
 * [secrets]
 * # Set via: wrangler secret put CLIENT_SECRET
 * # Set via: wrangler secret put WEBHOOK_SECRET
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * To deploy with wrangler CLI:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler kv:namespace create EVENTS
 *   (copy the id into wrangler.toml)
 *   wrangler secret put CLIENT_SECRET
 *   wrangler secret put WEBHOOK_SECRET
 *   wrangler deploy
 *
 * To deploy via Dashboard (no CLI needed):
 *   workers.cloudflare.com → Create Worker → paste this file → Save & Deploy
 *   Settings → Variables: CLIENT_ID (plain), CLIENT_SECRET + WEBHOOK_SECRET (secrets)
 *   KV → Create namespace "EVENTS" → Workers → Settings → KV Bindings → bind as EVENTS
 * ─────────────────────────────────────────────────────────────────────────────
 */
