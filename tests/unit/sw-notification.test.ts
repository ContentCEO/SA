import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
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
