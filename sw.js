const CACHE_NAME = "ca-alerta-v9";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./push-config.js",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "Há itens que precisam de acompanhamento." };
  }
  event.waitUntil(self.registration.showNotification(payload.title || "CA Alerta", {
    body: payload.body || "Abra o aplicativo para conferir os alertas de hoje.",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: payload.tag || "ca-alerta-diario",
    data: { url: payload.url || "./#certificados" }
  }));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("ca-alerta-") && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then(async response => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, copy);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "./#certificados";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(openClients => {
      const existing = openClients[0];
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
