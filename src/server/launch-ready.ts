/**
 * Check 50 P6: "Ready for paying owners" on /admin — what's left before the first paying owner,
 * in one list Davi can read and tick from his phone. Pure (no database, no `server-only`).
 *
 * Automatic rows read environment variable NAMES and safe derived facts only (a host's ending,
 * a key's live/test prefix); no value is ever returned, shown or logged. Hand rows are ticked by
 * Davi and stored as `app_settings` `launch_tick:<key>` = ISO date. Nothing reads these ticks to
 * change behaviour: no gate depends on them.
 */

export type LaunchState = "done" | "not yet" | "check by hand";

export type LaunchRow = {
  key: string;
  label: string;
  state: LaunchState;
  /** Plain words on how to finish it (and where LAUNCH.md says more). */
  how: string;
  /** A safe fact to show next to the state: "test key", "ticked Oct 17". Never a value. */
  detail?: string;
  /** Hand rows get a Done button until ticked. */
  hand: boolean;
};

export const HAND_CHECKS = [
  {
    key: "secrets_changed",
    label: "Passwords pasted in chat are changed",
    how: "docs/LAUNCH.md step 3: the Neon password and the Google client secret.",
  },
  {
    key: "preview_database",
    label: "Previews have their own database",
    how: "docs/LAUNCH.md step 2: the sa-preview Neon project and its own keys.",
  },
  {
    key: "google_verified",
    label: "Google approved Gmail access",
    how: "docs/LAUNCH.md step 0: verification and the security assessment.",
  },
  {
    key: "resend_domain",
    label: "Your email domain is verified in Resend",
    how: "docs/LAUNCH.md step 6.",
  },
  {
    key: "vercel_pro",
    label: "Vercel plan chosen (Pro for a business)",
    how: 'docs/LAUNCH.md "Check your free plans now", Vercel.',
  },
  {
    key: "inngest_plan",
    label: "Inngest plan checked",
    how: 'docs/LAUNCH.md "Check your free plans now", Inngest.',
  },
  {
    key: "main_protected",
    label: "The main branch is protected",
    how: 'docs/LAUNCH.md "Protect main".',
  },
  {
    key: "repo_visibility",
    label: "Decided whether the code stays public",
    how: "GitHub → the repository → Settings → General → Danger Zone → Change visibility.",
  },
  {
    key: "lawyer_terms",
    label: "A lawyer read the terms and privacy policy",
    how: 'docs/LAUNCH.md step 13, "Still needed from you".',
  },
  {
    key: "sales_tax",
    label: "Sales tax registration done",
    how: 'docs/LAUNCH.md "Start your sales tax registration now" and step 7e.',
  },
] as const;

export type HandKey = (typeof HAND_CHECKS)[number]["key"];

export function isHandKey(v: unknown): v is HandKey {
  return typeof v === "string" && HAND_CHECKS.some((c) => c.key === v);
}

export const LAUNCH_TICK_PREFIX = "launch_tick:";

export type LaunchFacts = {
  /** A webhook signing secret is stored by Connect Stripe (app_settings). */
  webhookSecretStored: boolean;
  /** Hand rows Davi ticked, with when. */
  ticks: Partial<Record<HandKey, Date>>;
};

type Env = Record<string, string | undefined>;

const set = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** The host of APP_URL, or null. Only used to check its ending; never returned. */
function hostOf(url: string | undefined): string | null {
  if (!set(url)) return null;
  try {
    return new URL(url!).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The domain of EMAIL_FROM ("Name <a@b.com>" or "a@b.com"), or null. Never returned. */
function emailDomain(from: string | undefined): string | null {
  if (!set(from)) return null;
  const m = /@([^\s>]+)\s*>?\s*$/.exec(from!.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** live / test / missing, from the key's prefix only. */
export function stripeKeyKind(key: string | undefined): "live" | "test" | "missing" {
  if (!set(key)) return "missing";
  return /^(sk|rk)_live_/.test(key!.trim()) ? "live" : "test";
}

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "America/New_York",
});

export function launchChecks(env: Env, facts: LaunchFacts): LaunchRow[] {
  const auto = (key: string, label: string, ok: boolean, how: string, detail?: string) =>
    ({ key, label, state: ok ? "done" : "not yet", how, hand: false, detail }) as LaunchRow;
  const host = hostOf(env.APP_URL);
  const fromDomain = emailDomain(env.EMAIL_FROM);
  const stripe = stripeKeyKind(env.STRIPE_SECRET_KEY);
  const rows: LaunchRow[] = [
    auto(
      "app_url",
      "The app is on your own web address",
      !!host && host !== "vercel.app" && !host.endsWith(".vercel.app"),
      "docs/LAUNCH.md step 5: add the domain in Vercel, then set APP_URL (Production).",
    ),
    auto(
      "email_from",
      "Emails come from your own domain",
      !!fromDomain && fromDomain !== "resend.dev" && !fromDomain.endsWith(".resend.dev"),
      "docs/LAUNCH.md step 6: verify the domain in Resend, then change EMAIL_FROM.",
    ),
    auto(
      "support_email",
      "A support email is set",
      set(env.SUPPORT_EMAIL),
      "docs/LAUNCH.md step 5: set SUPPORT_EMAIL (Production and Preview).",
    ),
    auto(
      "stripe_live",
      "Stripe takes real payments",
      stripe === "live",
      "docs/LAUNCH.md step 7: swap STRIPE_SECRET_KEY for the live key, then Connect Stripe.",
      stripe === "live" ? "live key" : stripe === "test" ? "test key" : "no key",
    ),
    auto(
      "stripe_webhook",
      "Stripe can tell us about payments",
      set(env.STRIPE_WEBHOOK_SECRET) || facts.webhookSecretStored,
      "Payments on this page → Connect Stripe.",
    ),
    auto(
      "inngest",
      "Background jobs are connected",
      set(env.INNGEST_SIGNING_KEY),
      "docs/SETUP.md §6: the Inngest Vercel integration sets INNGEST_SIGNING_KEY.",
    ),
    auto(
      "production",
      "This is the production site",
      env.VERCEL_ENV === "production",
      "Open this page on the production address, not a preview.",
    ),
  ];
  for (const c of HAND_CHECKS) {
    const at = facts.ticks[c.key];
    rows.push({
      key: c.key,
      label: c.label,
      state: at ? "done" : "check by hand",
      how: c.how,
      hand: true,
      ...(at ? { detail: `ticked ${shortDate.format(at)}` } : {}),
    });
  }
  return rows;
}

export function launchSummary(rows: LaunchRow[]) {
  return { done: rows.filter((r) => r.state === "done").length, total: rows.length };
}
