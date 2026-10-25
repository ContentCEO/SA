/**
 * Security headers for every response, built here (pure, tested) and applied in
 * next.config.ts. Kept as tight as the app allows:
 *
 * - Scripts and styles: our own, plus inline (Next's page data and the style
 *   attributes on a few components need it; nonces would force every page to
 *   render on request). `unsafe-eval` only in local development.
 * - Fonts are self-hosted (next/font/local, files in src/app/_fonts) and served from
 *   /_next/static/media on our own origin, so no Google Fonts host is needed.
 * - form-action allows the places a form legitimately ends up after a
 *   redirect: Google sign-in / Gmail connect and Stripe Checkout / Portal.
 * - Nobody may frame the site (clickjacking).
 * - Vercel's preview toolbar is allowed on preview deploys only.
 * - HTTPS only, remembered for a year (Strict-Transport-Security). Vercel already sends this on
 *   its own domains; we send it ourselves so a custom domain gets it too. No includeSubDomains
 *   or preload: Davi's other subdomains are not ours to pin. Browsers ignore it over plain http
 *   (localhost), so local development and e2e are unaffected.
 */
import { outlookOffered } from "./outlook";

export type HeaderEnv = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  NEXT_PUBLIC_SENTRY_DSN?: string;
  /** Plan #49: Outlook connect ends at Microsoft's sign-in page (only while it's offered). */
  FEATURE_OUTLOOK?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
};

function sentryOrigin(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    return new URL(dsn).origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(env: HeaderEnv = process.env): string {
  const dev = env.NODE_ENV === "development";
  const preview = env.VERCEL_ENV === "preview";
  const vercelLive = preview ? ["https://vercel.live"] : [];
  const sentry = sentryOrigin(env.NEXT_PUBLIC_SENTRY_DSN);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...vercelLive],
    "style-src": ["'self'", "'unsafe-inline'", ...vercelLive],
    "img-src": ["'self'", "data:", "blob:", ...vercelLive],
    "font-src": ["'self'", "data:", ...vercelLive],
    "connect-src": ["'self'", ...(dev ? ["ws:"] : []), ...(sentry ? [sentry] : []), ...vercelLive],
    "frame-src": [...(vercelLive.length ? vercelLive : ["'none'"])],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": [
      "'self'",
      "https://accounts.google.com",
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
      // Plan #49: only while Outlook is offered (FEATURE_OUTLOOK + credentials): off, unchanged.
      ...(outlookOffered(env) ? ["https://login.microsoftonline.com"] : []),
    ],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

export function securityHeaders(env: HeaderEnv = process.env) {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "Strict-Transport-Security", value: "max-age=31536000" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Check 26 P9: no other site's window keeps a handle on ours. Google sign-in, Gmail connect
    // and Stripe Checkout are full-page redirects, not popups, so nothing here needs one.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    {
      key: "Permissions-Policy",
      // Nothing uses the camera, location or payments APIs. The microphone is kept to our own
      // pages only, for voice-to-edit (plan #4, the draft editor's hold-to-talk).
      value: "camera=(), geolocation=(), payment=(), usb=(), browsing-topics=(), microphone=(self)",
    },
  ];
}
