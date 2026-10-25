/**
 * Check 33 P1: once APP_URL is Davi's own domain, every `*.vercel.app` address of the production
 * deployment forwards its pages there (permanent), so search engines see one site and Connect
 * Gmail is always started on the domain Google sends people back to. Nothing changes while
 * APP_URL is still a vercel.app address (today), on previews, or locally.
 *
 * `/api/*` and `/_next/*` are never redirected: Stripe's webhook, Inngest, the Gmail OAuth
 * callback and Pub/Sub keep working on the old address while LAUNCH.md step 5 items 5–7 move
 * them. Query strings carry through (Next does that by default). Pure, so it is unit-tested;
 * applied in next.config.ts `redirects()`.
 */

export type HostRedirectEnv = Record<string, string | undefined>;

/** Next's own `has: [{ type: "host" }]` rule shape (the few fields we use). */
export type HostRedirect = {
  source: string;
  has: { type: "host"; value: string }[];
  destination: string;
  permanent: boolean;
};

/** The paths that forward: everything except /api/* and /_next/*. */
export const LEGACY_HOST_SOURCE = "/:path((?!api/|_next/).*)";
/** Any vercel.app host (the team address, the project address, the branch address). */
export const LEGACY_HOST_PATTERN = "(?<sub>.+)\\.vercel\\.app";

/** The APP_URL origin to forward to, or null when nothing should forward. */
export function legacyHostTarget(env: HostRedirectEnv = process.env): string | null {
  if (env.VERCEL_ENV !== "production") return null;
  let url: URL;
  try {
    url = new URL(env.APP_URL ?? "");
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".vercel.app") || host === "vercel.app") return null;
  return url.origin;
}

export function legacyHostRedirects(env: HostRedirectEnv = process.env): HostRedirect[] {
  const origin = legacyHostTarget(env);
  if (!origin) return [];
  return [
    {
      source: LEGACY_HOST_SOURCE,
      has: [{ type: "host", value: LEGACY_HOST_PATTERN }],
      destination: `${origin}/:path`,
      permanent: true,
    },
  ];
}
