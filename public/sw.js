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
 * Where a notification tap may go (plan #34): the queue, the quote tracker, or
 * one queue card by its thread id, `/queue?t=<uuid>#t-<uuid>` (the query makes
 * it a real page load, so an open queue shows the new card). Anything else —
 * whatever the summary said — opens the queue. Kept in step with
 * isNotificationUrl in src/server/leads-at-risk-rules.ts.
 */
const CARD_URL =
  /^\/queue\?t=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#t-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function safeUrl(u) {
  if (u === "/queue" || u === "/quotes") return u;
  if (typeof u !== "string") return "/queue";
  const m = CARD_URL.exec(u);
  return m && m[1].toLowerCase() === m[2].toLowerCase() ? u : "/queue";
}

/*
 * The number on the home-screen icon (plan #38), where the phone supports it.
 * Signed out (401) or nothing waiting → cleared. No signal or a server error
 * leaves it as it was. Never throws, and never holds up the notification.
 */
function updateBadge(status, s) {
  try {
    const nav = self.navigator;
    if (!nav || typeof nav.setAppBadge !== "function") return Promise.resolve();
    const count = s && typeof s.count === "number" && isFinite(s.count) ? s.count : null;
    if (status === 401 || count === 0) {
      return typeof nav.clearAppBadge === "function"
        ? Promise.resolve(nav.clearAppBadge()).catch(() => {})
        : Promise.resolve();
    }
    if (count !== null && count > 0) {
      return Promise.resolve(nav.setAppBadge(Math.min(Math.floor(count), 99) || 1)).catch(() => {});
    }
  } catch {
    // A badge is never worth an error.
  }
  return Promise.resolve();
}

/*
 * Check 19 P3: the count lookup gets 4 seconds. A phone must show a notification for every
 * push (Safari drops the subscription after a few silent ones), so with one bar of signal we
 * give up waiting and show the plain line instead.
 */
const SUMMARY_TIMEOUT_MS = 4000;
function summarySignal() {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
    }
    if (typeof AbortController === "function" && typeof setTimeout === "function") {
      const c = new AbortController();
      setTimeout(() => c.abort(), SUMMARY_TIMEOUT_MS);
      return c.signal;
    }
  } catch {
    // No way to time it out: fall through to the race below.
  }
  return undefined;
}

/*
 * The summary (status + answer), never later than the time limit, even where fetch ignores
 * the signal or the answer's body stalls. No answer in time = { status: 0, s: null }.
 */
function fetchSummary() {
  const signal = summarySignal();
  const answer = fetch("/api/push/summary", {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  })
    .then((r) =>
      r.ok ? r.json().then((s) => ({ status: r.status, s })) : { status: r.status, s: null },
    )
    .catch(() => ({ status: 0, s: null }));
  if (typeof setTimeout !== "function") return answer;
  const late = new Promise((resolve) =>
    setTimeout(() => resolve({ status: 0, s: null }), SUMMARY_TIMEOUT_MS),
  );
  return Promise.race([answer, late]);
}

/*
 * Phone notifications (plan #36). The push is empty — the push service never
 * sees anything — so ask the app for today's counts and show those. If the
 * phone is signed out, or the answer takes too long, a plain line instead.
 */
self.addEventListener("push", (event) => {
  event.waitUntil(
    fetchSummary().then(({ status, s }) =>
      Promise.all([
        self.registration.showNotification((s && s.title) || "Squared Away", {
          body: (s && s.body) || "Something new is waiting in your queue.",
          icon: "/app-icon/192",
          badge: "/app-icon/192",
          tag: "sa-queue",
          renotify: true,
          data: { url: safeUrl(s && s.url) },
        }),
        updateBadge(status, s),
      ]),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // Going to the page a window is already on with only a #hash added or changed is a
        // jump within the page: no reload, so a stale queue would stay stale and no new card
        // would appear. Then go to it without the hash, which always loads afresh; the queue
        // finds the card from `?t=` instead.
        const here = new URL(open.url);
        const there = new URL(url, self.location.origin);
        const same = here.pathname === there.pathname && here.search === there.search;
        const go = same ? there.pathname + there.search : url;
        return open.navigate(go).then((w) => (w || open).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
