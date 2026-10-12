import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  actionLanding,
  applyBadge,
  type BadgeNavigator,
  badgeRefresher,
  refreshBadge,
} from "@/lib/app-badge";

/* Plan #38: the number on the home-screen icon. Pure; the browser's pieces are stand-ins. */

function nav(over: Partial<Record<keyof BadgeNavigator, unknown>> = {}) {
  return {
    setAppBadge: vi.fn(async () => {}),
    clearAppBadge: vi.fn(async () => {}),
    ...over,
  } as unknown as Required<BadgeNavigator> & {
    setAppBadge: ReturnType<typeof vi.fn>;
    clearAppBadge: ReturnType<typeof vi.fn>;
  };
}
const res = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("applyBadge", () => {
  it("a browser without the Badging API → 'unsupported', and never throws", async () => {
    expect(await applyBadge(undefined, 3)).toBe("unsupported");
    expect(await applyBadge(null, 0)).toBe("unsupported");
    expect(await applyBadge({}, 3)).toBe("unsupported");
    expect(await applyBadge({}, 0)).toBe("unsupported");
  });

  it("a count shows on the icon; 0 clears it", async () => {
    const n = nav();
    expect(await applyBadge(n, 3)).toBe("set");
    expect(n.setAppBadge).toHaveBeenCalledWith(3);
    expect(await applyBadge(n, 0)).toBe("cleared");
    expect(n.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("caps at 99", async () => {
    const n = nav();
    await applyBadge(n, 250);
    expect(n.setAppBadge).toHaveBeenCalledWith(99);
  });

  it("anything that isn't a real count clears it", async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const n = nav();
      expect(await applyBadge(n, bad), String(bad)).toBe("cleared");
      expect(n.setAppBadge).not.toHaveBeenCalled();
    }
  });

  it("the browser refusing (throwing or rejecting) → 'unsupported', no error", async () => {
    const throws = nav({
      setAppBadge: () => {
        throw new Error("NotAllowedError");
      },
    });
    expect(await applyBadge(throws, 3)).toBe("unsupported");
    const rejects = nav({ clearAppBadge: async () => Promise.reject(new Error("nope")) });
    expect(await applyBadge(rejects, 0)).toBe("unsupported");
  });
});

describe("refreshBadge (what a signed-in screen does)", () => {
  it("shows the route's count", async () => {
    const n = nav();
    const fetcher = vi.fn(async () => res(200, { count: 2 }));
    expect(await refreshBadge(n, fetcher)).toBe("set");
    expect(n.setAppBadge).toHaveBeenCalledWith(2);
    // The light count route, never the notification summary, and never from a cache.
    expect(fetcher).toHaveBeenCalledWith("/api/badge", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("0 waiting, or signed out (401) → cleared", async () => {
    const zero = nav();
    expect(await refreshBadge(zero, async () => res(200, { count: 0 }))).toBe("cleared");
    expect(zero.clearAppBadge).toHaveBeenCalled();
    const out = nav();
    expect(await refreshBadge(out, async () => res(401, { error: "Sign in first." }))).toBe(
      "cleared",
    );
    expect(out.clearAppBadge).toHaveBeenCalled();
  });

  it("A31: no signal, a server error or a garbled answer leaves the badge alone", async () => {
    const cases = [
      async () => Promise.reject(new TypeError("Failed to fetch")),
      async () => res(500),
      async () => res(503, { count: 0 }),
      async () => res(200, { count: "2" }),
      async () => res(200, null),
      async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError()) }),
    ];
    for (const fetcher of cases) {
      const n = nav();
      expect(await refreshBadge(n, fetcher)).toBe("skipped");
      expect(n.setAppBadge).not.toHaveBeenCalled();
      expect(n.clearAppBadge).not.toHaveBeenCalled();
    }
  });

  it("a browser without a badge doesn't even ask", async () => {
    const fetcher = vi.fn(async () => res(200, { count: 2 }));
    expect(await refreshBadge({}, fetcher)).toBe("unsupported");
    expect(await refreshBadge(undefined, fetcher)).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("badgeRefresher (A32: at most one request a minute)", () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("asks once, then not again inside 60s; again after", async () => {
    const c = clock();
    const fetcher = vi.fn(async () => res(200, { count: 2 }));
    const refresh = badgeRefresher(nav(), fetcher, c.now);
    expect(await refresh()).toBe("set");
    c.advance(10_000);
    expect(await refresh()).toBe("throttled");
    expect(fetcher).toHaveBeenCalledTimes(1);
    c.advance(51_000); // 61s after the first ask
    expect(await refresh()).toBe("set");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never sends a second request while the first is still out — forced or not", async () => {
    let answer: (v: ReturnType<typeof res>) => void = () => {};
    const fetcher = vi.fn(
      () => new Promise<ReturnType<typeof res>>((resolve) => (answer = resolve)),
    );
    const c = clock();
    const refresh = badgeRefresher(nav(), fetcher, c.now);
    const first = refresh();
    c.advance(120_000);
    expect(await refresh()).toBe("throttled");
    expect(await refresh({ force: true })).toBe("throttled");
    expect(fetcher).toHaveBeenCalledTimes(1);
    answer(res(200, { count: 1 }));
    expect(await first).toBe("set");
  });

  it("a forced refresh (a queue action just landed) skips the minute", async () => {
    const c = clock();
    const n = nav();
    let count = 2;
    const fetcher = vi.fn(async () => res(200, { count }));
    const refresh = badgeRefresher(n, fetcher, c.now);
    await refresh();
    expect(n.setAppBadge).toHaveBeenLastCalledWith(2);
    // Both replies sent within the minute: the icon must not keep saying 2.
    c.advance(5_000);
    count = 0;
    expect(await refresh({ force: true })).toBe("cleared");
    expect(n.clearAppBadge).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A forced ask restarts the minute for ordinary asks.
    c.advance(10_000);
    expect(await refresh()).toBe("throttled");
  });

  it("a failed request still counts against the minute and frees the next ask", async () => {
    const c = clock();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(res(200, { count: 3 }));
    const refresh = badgeRefresher(nav(), fetcher, c.now);
    expect(await refresh()).toBe("skipped");
    expect(await refresh()).toBe("throttled");
    expect(await refresh({ force: true })).toBe("set");
  });

  it("a phone without a badge never asks", async () => {
    const fetcher = vi.fn(async () => res(200, { count: 2 }));
    const refresh = badgeRefresher({}, fetcher, clock().now);
    expect(await refresh({ force: true })).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("actionLanding (which URLs mean a queue action just happened)", () => {
  it("sent / done / error landings give a key; anything else doesn't", () => {
    expect(actionLanding("sent=abc")).toBe("sent=abc");
    expect(actionLanding("?done=discarded")).toBe("done=discarded");
    expect(actionLanding("error=gone&x=1")).toBe("error=gone");
    expect(actionLanding("done=practice&left=3")).toBe("done=practice");
    expect(actionLanding("sent=a")).not.toBe(actionLanding("sent=b"));
    expect(actionLanding("")).toBeNull();
    expect(actionLanding(null)).toBeNull();
    expect(actionLanding(undefined)).toBeNull();
    expect(actionLanding("cat=quote_request")).toBeNull();
  });
});

describe("where the badge is kept and cleared", () => {
  it("the helper is browser-safe (no server code)", () => {
    const src = readFileSync("src/lib/app-badge.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|@\/server/);
  });

  it("signed-in screens keep it, at most once a minute; signed-out screens clear it", () => {
    const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
    expect(layout).toContain("<AppBadge />");
    const comp = readFileSync("src/components/app/app-badge.tsx", "utf8");
    // The minute gate lives in badgeRefresher (tested above); the screen goes through it.
    expect(comp).toContain("badgeRefresher(");
    expect(comp).not.toMatch(/refreshBadge\(/);
    expect(comp).toMatch(/actionLanding\(/);
    const forget = readFileSync("src/components/app/forget-offline.tsx", "utf8");
    expect(forget).toMatch(/applyBadge\(navigator, 0\)/);
    // Every screen sign-out or account deletion lands on.
    for (const page of [
      "src/app/page.tsx",
      "src/app/signin/page.tsx",
      "src/app/goodbye/page.tsx",
    ]) {
      expect(readFileSync(page, "utf8"), page).toContain("<ForgetOffline />");
    }
  });
});
