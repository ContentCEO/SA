/*
 * Squared Away service worker. By default it never caches pages or data (they
 * contain customer email), only a plain offline page, shown when a screen
 * can't load because there's no signal.
 *
 * Plan #10, opt-in per phone: when the owner switches on "Keep my queue on
 * this phone", the page creates the QUEUE cache. Only while that cache exists
 * do we keep the last /queue page and the app's own script files (no customer
 * data in those) so the queue opens with no signal. Switching it off, signing
 * out or deleting the account deletes the cache.
 */
const CACHE = "sa-offline-v1";
const QUEUE = "sa-queue-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== QUEUE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

const offlinePage = () =>
  caches.match(OFFLINE_URL).then((r) => r || new Response("Offline", { status: 503 }));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The app's own script and style files: kept only for an opted-in phone.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.ok && (await caches.has(QUEUE))) {
            const copy = res.clone();
            caches.open(QUEUE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { cacheName: QUEUE }).then((r) => r || Response.error())),
    );
    return;
  }

  if (req.mode !== "navigate") return;

  // Leaving the account: forget any kept queue.
  if (url.pathname === "/signin" || url.pathname === "/goodbye") {
    event.waitUntil(caches.delete(QUEUE));
    return;
  }

  if (url.pathname === "/queue") {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.ok && !res.redirected && (await caches.has(QUEUE))) {
            const copy = res.clone();
            caches.open(QUEUE).then((c) => c.put("/queue", copy));
          }
          return res;
        })
        .catch(() => caches.match("/queue", { cacheName: QUEUE }).then((r) => r || offlinePage())),
    );
    return;
  }

  event.respondWith(fetch(req).catch(offlinePage));
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
