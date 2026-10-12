/**
 * Plan #38: the number on the app's home-screen icon (the Badging API), where the phone
 * supports it. Browser-safe and pure: the page, the signed-out screens and the tests share it.
 * The number is a count only — replies ready plus emails that need the owner — never what
 * they are about. Anything the browser does wrong is swallowed: a badge is never worth an error.
 */

/** The two Badging API calls, as `navigator` (or a worker's `self.navigator`) has them. */
export type BadgeNavigator = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Icons have room for two digits; past that the number stops being useful anyway. */
export const BADGE_MAX = 99;

/** How often a signed-in screen may ask for the count (plan M8 A32). */
export const BADGE_REFRESH_MS = 60_000;

export type BadgeOutcome = "set" | "cleared" | "unsupported";

/** Show `count` on the icon, or clear it at 0 (and for anything that isn't a real count). */
export async function applyBadge(
  nav: BadgeNavigator | undefined | null,
  count: number,
): Promise<BadgeOutcome> {
  try {
    if (!nav) return "unsupported";
    if (Number.isFinite(count) && count > 0) {
      if (typeof nav.setAppBadge !== "function") return "unsupported";
      await nav.setAppBadge(Math.min(Math.floor(count), BADGE_MAX) || 1);
      return "set";
    }
    if (typeof nav.clearAppBadge !== "function") return "unsupported";
    await nav.clearAppBadge();
    return "cleared";
  } catch {
    return "unsupported";
  }
}

/** Whether this browser can put a number on the app icon at all. */
export function badgeSupported(nav: BadgeNavigator | undefined | null): boolean {
  return !!nav && typeof nav.setAppBadge === "function";
}

type BadgeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

/**
 * Ask the app for the count and show it. Signed out (401) or nothing waiting → cleared. A
 * network failure or a server error leaves the badge as it was (plan M8 A31): no signal is
 * not the same as nothing to do.
 */
export async function refreshBadge(
  nav: BadgeNavigator | undefined | null,
  fetcher: (url: string, init: RequestInit) => Promise<BadgeResponse>,
): Promise<BadgeOutcome | "skipped"> {
  if (!badgeSupported(nav)) return "unsupported";
  let res: BadgeResponse;
  try {
    res = await fetcher("/api/badge", { cache: "no-store", credentials: "same-origin" });
  } catch {
    return "skipped";
  }
  if (res.status === 401) return applyBadge(nav, 0);
  if (!res.ok) return "skipped";
  let count: unknown;
  try {
    count = ((await res.json()) as { count?: unknown } | null)?.count;
  } catch {
    return "skipped";
  }
  if (typeof count !== "number") return "skipped";
  return applyBadge(nav, count);
}

/**
 * The once-a-minute gate a signed-in screen asks through (plan M8 A32). Holds when it last asked
 * and whether a request is still out, so moving between screens never piles up requests.
 * `force` skips the minute (never a request already in flight): after a queue action the count
 * has just changed, and the icon must not keep showing replies that are gone.
 */
export function badgeRefresher(
  nav: BadgeNavigator | undefined | null,
  fetcher: (url: string, init: RequestInit) => Promise<BadgeResponse>,
  now: () => number = Date.now,
): (opts?: { force?: boolean }) => Promise<BadgeOutcome | "skipped" | "throttled"> {
  let lastAsked: number | null = null;
  let asking = false;
  return async ({ force = false } = {}) => {
    if (asking) return "throttled";
    if (!force && lastAsked !== null && now() - lastAsked < BADGE_REFRESH_MS) return "throttled";
    asking = true;
    lastAsked = now();
    try {
      return await refreshBadge(nav, fetcher);
    } finally {
      asking = false;
    }
  };
}

/**
 * Queue actions land back on a screen with `?sent=`, `?done=` or `?error=` (send, undo, discard,
 * snooze, draft). Those are the moments the count changes, so the badge asks again at once.
 * Returns a key that differs per landing, or null when nothing just happened.
 */
export function actionLanding(search: string | null | undefined): string | null {
  const params = new URLSearchParams(search ?? "");
  const parts = ["sent", "done", "error"].flatMap((k) =>
    params.has(k) ? [`${k}=${params.get(k)}`] : [],
  );
  return parts.length ? parts.join("&") : null;
}
