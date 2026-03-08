// DevOps AI Platform — Service Worker
// Caches app shell for offline access. API calls always go to network.
const CACHE = "devopsai-v1";
const SHELL = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Always network-first for API calls (GitHub, Claude, Ollama, OpenRouter)
  const isAPI = ["api.github.com","api.anthropic.com","openrouter.ai","localhost"].some(h => url.hostname.includes(h));
  if (isAPI || e.request.method !== "GET") return; // let it pass through

  // Cache-first for app shell
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && res.type === "basic") {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match("/index.html")); // offline fallback
    })
  );
});
