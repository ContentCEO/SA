import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNotificationUrl } from "@/server/leads-at-risk-rules";

/*
 * Plan #34 (A25): the service worker opens only links on the allow-list, whatever
 * /api/push/summary answered, and a tap is a real navigation to one queue card. The worker is
 * plain script, so it runs here in a sandbox with stand-ins for the browser's pieces.
 */
const SRC = readFileSync("public/sw.js", "utf8");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function loadWorker(summary: unknown, windows: { url: string }[] = []) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: { data: { url: string } } }[] = [];
  const navigate = vi.fn(async () => null);
  const focus = vi.fn();
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: "https://sa.example" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    registration: {
      showNotification: async (title: string, options: { data: { url: string } }) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () => windows.map((w) => ({ ...w, navigate, focus })),
      openWindow,
    },
  };
  runInNewContext(SRC, {
    self,
    URL,
    caches: {},
    fetch: async () => ({ ok: true, json: async () => summary }),
  });
  const run = async (type: string, event: object) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { run, shown, navigate, openWindow };
}

describe("service worker: where a notification tap goes", () => {
  const cases: [unknown, string][] = [
    [`/queue?t=${A}#t-${A}`, `/queue?t=${A}#t-${A}`],
    ["/quotes", "/quotes"],
    ["/queue", "/queue"],
    // Anything else opens the queue.
    [`/queue#t-${A}`, "/queue"],
    [`/queue?t=${A}#t-${B}`, "/queue"],
    ["https://evil.example/queue", "/queue"],
    ["//evil.example", "/queue"],
    [`/queue?t=${A}&e=dana@x.com#t-${A}`, "/queue"],
    ["/settings", "/queue"],
    ["javascript:alert(1)", "/queue"],
    [undefined, "/queue"],
    [42, "/queue"],
  ];

  it("keeps only allow-listed links from the summary (same list as the server's rule)", async () => {
    for (const [given, expected] of cases) {
      const w = loadWorker({ title: "Squared Away", body: "1 email needs you", url: given });
      await w.run("push", {});
      expect(w.shown[0]!.options.data.url, String(given)).toBe(expected);
      expect(isNotificationUrl(expected)).toBe(true);
    }
    // Signed out (no summary): the queue.
    const out = loadWorker(null);
    await out.run("push", {});
    expect(out.shown[0]!.options.data.url).toBe("/queue");
  });

  it("a tap navigates an open window to the card (a real load), or opens one", async () => {
    const card = `/queue?t=${A}#t-${A}`;
    const open = loadWorker(null, [{ url: "https://sa.example/queue" }]);
    await open.run("notificationclick", { notification: { close() {}, data: { url: card } } });
    expect(open.navigate).toHaveBeenCalledWith(card);

    // Already on that very card (an earlier tap): same path and query, so a navigation with
    // the hash would only jump within the stale page. It loads afresh without the hash.
    for (const here of [`/queue?t=${A}#t-${A}`, `/queue?t=${A}`]) {
      const same = loadWorker(null, [{ url: `https://sa.example${here}` }]);
      await same.run("notificationclick", { notification: { close() {}, data: { url: card } } });
      expect(same.navigate, here).toHaveBeenCalledWith(`/queue?t=${A}`);
    }
    // On another card: the query differs, so the full link is already a real load.
    const other = loadWorker(null, [{ url: `https://sa.example/queue?t=${B}#t-${B}` }]);
    await other.run("notificationclick", { notification: { close() {}, data: { url: card } } });
    expect(other.navigate).toHaveBeenCalledWith(card);
    // On the queue after a card jump (`/queue#t-…`), a plain /queue tap reloads it as is.
    const plain = loadWorker(null, [{ url: `https://sa.example/queue#t-${B}` }]);
    await plain.run("notificationclick", {
      notification: { close() {}, data: { url: "/queue" } },
    });
    expect(plain.navigate).toHaveBeenCalledWith("/queue");

    const none = loadWorker(null);
    await none.run("notificationclick", { notification: { close() {}, data: { url: card } } });
    expect(none.openWindow).toHaveBeenCalledWith(card);

    // A notification carrying anything else (an older worker's, or tampered) opens the queue.
    const bad = loadWorker(null);
    await bad.run("notificationclick", {
      notification: { close() {}, data: { url: "https://evil.example/" } },
    });
    expect(bad.openWindow).toHaveBeenCalledWith("/queue");
    const bare = loadWorker(null);
    await bare.run("notificationclick", { notification: { close() {} } });
    expect(bare.openWindow).toHaveBeenCalledWith("/queue");
  });
});

/* Plan #38: a push also updates the number on the home-screen icon (A31). */
describe("service worker: the home-screen badge on a push", () => {
  function badgeWorker(
    answer: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
    navigator: object | undefined = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    },
  ) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const shown: string[] = [];
    runInNewContext(SRC, {
      self: {
        location: { origin: "https://sa.example" },
        navigator,
        addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
        registration: { showNotification: async (title: string) => void shown.push(title) },
        clients: {},
      },
      URL,
      caches: {},
      fetch: answer,
    });
    const run = async () => {
      let done: Promise<unknown> = Promise.resolve();
      listeners.push!({ waitUntil: (p: Promise<unknown>) => (done = p) });
      await done;
    };
    return {
      run,
      shown,
      nav: navigator as {
        setAppBadge: ReturnType<typeof vi.fn>;
        clearAppBadge: ReturnType<typeof vi.fn>;
      },
    };
  }
  const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

  it("shows the summary's count, capped at 99; 0 clears it", async () => {
    const three = badgeWorker(ok({ title: "Squared Away", body: "x", url: "/queue", count: 3 }));
    await three.run();
    expect(three.nav.setAppBadge).toHaveBeenCalledWith(3);
    expect(three.shown).toHaveLength(1);
    const many = badgeWorker(ok({ count: 250 }));
    await many.run();
    expect(many.nav.setAppBadge).toHaveBeenCalledWith(99);
    const zero = badgeWorker(ok({ count: 0 }));
    await zero.run();
    expect(zero.nav.clearAppBadge).toHaveBeenCalled();
    expect(zero.nav.setAppBadge).not.toHaveBeenCalled();
  });

  it("signed out (401) clears it; no signal or a server error leaves it alone", async () => {
    const out = badgeWorker(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await out.run();
    expect(out.nav.clearAppBadge).toHaveBeenCalled();
    expect(out.shown).toHaveLength(1);

    for (const answer of [
      async () => Promise.reject(new TypeError("Failed to fetch")),
      async () => ({ ok: false, status: 500, json: async () => ({ count: 0 }) }),
      ok({ title: "Squared Away" }), // an older server: no count
      ok(null),
    ]) {
      const w = badgeWorker(answer);
      await w.run();
      expect(w.nav.setAppBadge).not.toHaveBeenCalled();
      expect(w.nav.clearAppBadge).not.toHaveBeenCalled();
      // The notification still shows.
      expect(w.shown).toHaveLength(1);
    }
  });

  it("a phone without the Badging API, or one that refuses, still gets the notification", async () => {
    const none = badgeWorker(ok({ count: 2 }), undefined);
    await none.run();
    expect(none.shown).toHaveLength(1);
    const refuses = badgeWorker(ok({ count: 2 }), {
      setAppBadge: () => Promise.reject(new Error("NotAllowedError")),
      clearAppBadge: async () => {},
    });
    await refuses.run();
    expect(refuses.shown).toHaveLength(1);
    const throws = badgeWorker(ok({ count: 2 }), {
      setAppBadge: () => {
        throw new Error("boom");
      },
      clearAppBadge: async () => {},
    });
    await throws.run();
    expect(throws.shown).toHaveLength(1);
  });
});

/* Check 19 P3: every push shows a notification within about 4 seconds, whatever the signal. */
describe("service worker: the count lookup has a time limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function hangingWorker(withAbort: boolean) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const shown: { title: string; options: { body: string; badge: string } }[] = [];
    const nav = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    const seen: { signal?: AbortSignal }[] = [];
    runInNewContext(SRC, {
      self: {
        location: { origin: "https://sa.example" },
        navigator: nav,
        addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
        registration: {
          showNotification: async (title: string, options: { body: string; badge: string }) =>
            void shown.push({ title, options }),
        },
        clients: {},
      },
      URL,
      caches: {},
      setTimeout,
      ...(withAbort ? { AbortController } : {}),
      // A basement with one bar: the answer never comes (unless the signal gives up).
      fetch: (_url: string, init: { signal?: AbortSignal }) => {
        seen.push(init);
        return new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("AbortError"))),
        );
      },
    });
    let done: Promise<unknown> = Promise.resolve();
    listeners.push!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    return { done, shown, nav, seen };
  }

  for (const withAbort of [true, false]) {
    it(`shows the plain line after 4 seconds (${withAbort ? "with" : "without"} an abort signal)`, async () => {
      vi.useFakeTimers();
      const w = hangingWorker(withAbort);
      await vi.advanceTimersByTimeAsync(3_900);
      expect(w.shown).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      await w.done;
      expect(w.shown).toHaveLength(1);
      expect(w.shown[0]!.title).toBe("Squared Away");
      expect(w.shown[0]!.options.body).toBe("Something new is waiting in your queue.");
      // No answer: the badge is left as it was.
      expect(w.nav.setAppBadge).not.toHaveBeenCalled();
      expect(w.nav.clearAppBadge).not.toHaveBeenCalled();
      if (withAbort) expect(w.seen[0]!.signal).toBeDefined();
    });
  }
});
