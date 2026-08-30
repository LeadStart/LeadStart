// LeadStart push service worker. Deliberately minimal — it exists only to
// receive web-push for hot-lead reply notifications and route a tap to the
// right inbox thread. No offline caching (yet). Served at /app/sw.js (the app
// runs under basePath /app), scope /app/.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = {};
  }
  const title = data.title || "New reply";
  const options = {
    body: data.body || "",
    icon: data.icon || "/app/icon-192.png",
    badge: data.badge || "/app/icon-192.png",
    tag: data.tag || undefined,
    data: { url: data.url || "/app/admin/inbox" },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) ||
    "/app/admin/inbox";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing app tab and route it, else open a new one.
        for (const client of clientList) {
          if ("focus" in client) {
            if ("navigate" in client) {
              try {
                client.navigate(url);
              } catch (_e) {
                /* cross-origin/edge — fall through to focus */
              }
            }
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      }),
  );
});

// Take control promptly so a freshly-enabled subscription starts receiving.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
