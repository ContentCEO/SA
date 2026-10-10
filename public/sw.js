/*
 * Squared Away service worker. Deliberately tiny: it never caches pages or
 * data (they contain customer email), only a plain offline page, shown when
 * a screen can't load because there's no signal.
 */
const CACHE = "sa-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then((r) => r || new Response("Offline", { status: 503 })),
    ),
  );
});

/*
 * Phone notifications (plan #36). The push is empty — the push service never
 * sees anything — so ask the app for today's counts and show those. If the
 * phone is signed out, a plain line instead.
 */
self.addEventListener("push", (event) => {
  event.waitUntil(
    fetch("/api/push/summary", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((s) =>
        self.registration.showNotification((s && s.title) || "Squared Away", {
          body: (s && s.body) || "Something new is waiting in your queue.",
          icon: "/app-icon/192",
          badge: "/app-icon/192",
          tag: "sa-queue",
          renotify: true,
          data: { url: "/queue" },
        }),
      ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.navigate("/queue").then((w) => (w || open).focus());
      return self.clients.openWindow("/queue");
    }),
  );
});
