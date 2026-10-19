/**
 * Check 28 P6: the public pages the way Google's verification reviewer reads them (Google help
 * 13807376: homepage public without sign-in, linking a privacy policy on the same domain that
 * describes Google user data use). Pure: it takes what `scripts/google-ready.ts` fetched (status,
 * headers, HTML) and returns PASS / FAIL lines in plain words. It never keeps or prints a page
 * body; only pass or fail and the reason.
 */

export type FetchedPage = {
  /** HTTP status of the final response. */
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** The body (HTML or JSON). */
  body: string;
  /** Where a redirect pointed, if the response was one (absolute URL), else null. */
  redirectedTo?: string | null;
};

export type ReadyInput = {
  /** The base URL checked, e.g. https://example.com. */
  base: string;
  pages: {
    home: FetchedPage;
    privacy: FetchedPage;
    terms: FetchedPage;
    health: FetchedPage;
  };
  /** Google's Limited Use sentence as written in docs/google-verification.md (Markdown). */
  limitedUseSentence: string;
};

export type ReadyCheck = { name: string; ok: boolean; reason?: string };

/** `[text](url)` → text, then whitespace collapsed: the sentence as a page shows it. */
export function markdownToText(md: string): string {
  return normalizeText(md.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1"));
}

/** HTML → its visible text, entities decoded enough to compare sentences. */
export function htmlToText(html: string): string {
  return normalizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      // Block-level tags separate words; inline ones (a, strong, code) don't, so "Policy</a>,"
      // stays "Policy," as a reader sees it.
      .replace(
        /<\/?(?:p|li|h[1-6]|div|tr|td|th|br|section|main|nav|ul|ol|table|header|footer|blockquote)\b[^>]*>/gi,
        " ",
      )
      .replace(/<[^>]+>/g, "")
      .replace(/&apos;|&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " "),
  );
}

function normalizeText(s: string): string {
  return s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

/** Every href in the HTML, as written. */
export function hrefs(html: string): string[] {
  return [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]!);
}

/** Does the HTML link to `path` on this host (relative, or absolute on the same origin)? */
export function linksTo(html: string, path: string, base: string): boolean {
  const origin = new URL(base).origin;
  return hrefs(html).some((h) => {
    if (h === path || h.startsWith(`${path}?`) || h.startsWith(`${path}#`)) return true;
    try {
      const u = new URL(h, origin);
      return u.origin === origin && u.pathname === path;
    } catch {
      return false;
    }
  });
}

function sameHost(base: string, url: string | null | undefined): boolean {
  if (!url) return true;
  try {
    return new URL(url, base).host === new URL(base).host;
  } catch {
    return false;
  }
}

export function isVercelHost(base: string): boolean {
  try {
    const h = new URL(base).hostname.toLowerCase();
    return h === "vercel.app" || h.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

export function googleReadyChecks(input: ReadyInput): ReadyCheck[] {
  const { base, pages, limitedUseSentence } = input;
  const out: ReadyCheck[] = [];
  const page = (name: string, p: FetchedPage, path: string) => {
    if (p.redirectedTo && !sameHost(base, p.redirectedTo)) {
      out.push({
        name: `${path} opens without sign-in`,
        ok: false,
        reason: `it sends people to another host (${safeHost(p.redirectedTo)})`,
      });
      return false;
    }
    if (p.status !== 200) {
      out.push({
        name: `${path} opens without sign-in`,
        ok: false,
        reason: `it answered ${p.status}, not 200`,
      });
      return false;
    }
    out.push({ name: `${path} opens without sign-in`, ok: true });
    void name;
    return true;
  };

  const homeOk = page("home", pages.home, "/");
  const privacyOk = page("privacy", pages.privacy, "/privacy");
  const termsOk = page("terms", pages.terms, "/terms");

  out.push(
    homeOk && linksTo(pages.home.body, "/privacy", base) && linksTo(pages.home.body, "/terms", base)
      ? { name: "the homepage links to /privacy and /terms on this host", ok: true }
      : {
          name: "the homepage links to /privacy and /terms on this host",
          ok: false,
          reason: homeOk
            ? "one of the links is missing or points elsewhere"
            : "the homepage didn't open",
        },
  );

  const privacyText = privacyOk ? htmlToText(pages.privacy.body) : "";
  const sentence = markdownToText(limitedUseSentence);
  out.push(
    privacyText.includes(sentence)
      ? { name: "/privacy has Google's Limited Use sentence, word for word", ok: true }
      : {
          name: "/privacy has Google's Limited Use sentence, word for word",
          ok: false,
          reason: "the sentence from docs/google-verification.md isn't on the page",
        },
  );
  out.push(
    /Google user data|Google API Services/i.test(privacyText)
      ? { name: "/privacy describes Google user data", ok: true }
      : {
          name: "/privacy describes Google user data",
          ok: false,
          reason: 'neither "Google user data" nor the Google API Services heading is on the page',
        },
  );

  out.push(
    termsOk && !pages.terms.body.includes("[To confirm]")
      ? { name: "/terms has no [To confirm] left", ok: true }
      : {
          name: "/terms has no [To confirm] left",
          ok: false,
          reason: termsOk
            ? "the terms still carry [To confirm] (the legal release)"
            : "the terms didn't open",
        },
  );

  for (const [path, p, ok] of [
    ["/privacy", pages.privacy, privacyOk],
    ["/terms", pages.terms, termsOk],
  ] as const) {
    out.push(
      ok && /href=["']mailto:/i.test(p.body)
        ? { name: `${path} shows a contact email`, ok: true }
        : {
            name: `${path} shows a contact email`,
            ok: false,
            reason: ok
              ? "no email address in the contact block (SUPPORT_EMAIL is unset)"
              : "the page didn't open",
          },
    );
  }

  out.push(
    isVercelHost(base)
      ? {
          name: "the site is on a domain you own",
          ok: false,
          reason: "this is a vercel.app address; Google requires a domain you own and have proved",
        }
      : { name: "the site is on a domain you own", ok: true },
  );

  for (const [path, p] of [
    ["/", pages.home],
    ["/privacy", pages.privacy],
    ["/terms", pages.terms],
  ] as const) {
    const robots = p.headers["x-robots-tag"] ?? "";
    out.push(
      /noindex/i.test(robots)
        ? {
            name: `${path} isn't hidden from search`,
            ok: false,
            reason: "the response carries x-robots-tag: noindex",
          }
        : { name: `${path} isn't hidden from search`, ok: true },
    );
    out.push(
      p.headers["x-powered-by"]
        ? {
            name: `${path} doesn't announce its framework`,
            ok: false,
            reason: "the response carries x-powered-by",
          }
        : { name: `${path} doesn't announce its framework`, ok: true },
    );
  }

  const commit = healthCommit(pages.health);
  out.push(
    pages.health.status === 200 && commit
      ? { name: `/api/health answers (commit ${commit})`, ok: true }
      : {
          name: "/api/health answers",
          ok: false,
          reason:
            pages.health.status === 200
              ? "no commit in the answer"
              : `it answered ${pages.health.status}`,
        },
  );
  return out;
}

/** The `commit` field of /api/health's JSON, or null. Never anything else from the body. */
export function healthCommit(p: FetchedPage): string | null {
  try {
    const parsed = JSON.parse(p.body) as { commit?: unknown };
    return typeof parsed.commit === "string" && /^[0-9a-z._-]{1,40}$/i.test(parsed.commit)
      ? parsed.commit
      : null;
  } catch {
    return null;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "another address";
  }
}

/** One line per check, in plain words. */
export function formatChecks(checks: ReadyCheck[]): string[] {
  return checks.map((c) => (c.ok ? `PASS ${c.name}` : `FAIL ${c.name}: ${c.reason ?? ""}`.trim()));
}

/** The Limited Use sentence from docs/google-verification.md's "Google API Services" section. */
export function limitedUseSentenceFrom(doc: string): string {
  const start = doc.indexOf("\n## Google API Services: Limited Use\n");
  if (start < 0) throw new Error("docs/google-verification.md has no Limited Use section.");
  const rest = doc.slice(start + "\n## Google API Services: Limited Use\n".length).trimStart();
  const end = rest.indexOf("\n\n");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}
