import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { models } from "@/config/models";
import { GMAIL_SCOPES } from "@/mailbox/gmail/scopes";
import { SALES_TAX_ON_NOTE } from "@/server/billing-rules";
import { sendingOffLabel } from "@/server/lifecycle";
import { ROOT, sourceFiles, SRC } from "../support/source-ast";

/**
 * Plan M11 S7: docs/LAUNCH.md is Davi's launch checklist. It must never carry a secret value
 * (names only), its links must lead somewhere, it must cover every setting SETUP.md marks as
 * required, and the things it tells him to look for (screens, settings keys, job names) must be
 * what the code actually shows.
 */

const LAUNCH_PATH = "docs/LAUNCH.md";
const launch = readFileSync(LAUNCH_PATH, "utf8");
const setup = readFileSync("docs/SETUP.md", "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

/** Step 0 (Google verification), raw. */
const sections0 = () => launch.slice(launch.indexOf("## 0. "), launch.indexOf("## 1. "));

/** Folders that hold generated or installed files, never ours. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".vercel",
  "test-results",
  "playwright-report",
  "coverage",
]);

/** Every Markdown file in the repo (README.md and friends included), relative to the root. */
function markdownFiles(dir: string = ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (name.endsWith(".md")) out.push(relative(ROOT, path));
  }
  return out;
}

/** Every file a secret could slip into: every Markdown file, plus the env template. */
const DOC_FILES = [...markdownFiles(), ".env.example"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Patterns for real credentials. Each one is exercised against a planted sample below. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Stripe secret / restricted key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{8,}/],
  ["Resend API key", /\bre_[A-Za-z0-9_]{16,}/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{20,}/],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{8,}/],
  ["Neon password", /\bnpg_[A-Za-z0-9]{8,}/],
  ["Twilio account SID", /\bAC[0-9a-f]{32}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["32+ character hex run", /\b[0-9a-f]{32,}\b/],
];

/**
 * A 40+ character base64 run with upper case, lower case and digits mixed in: a random key.
 * (Paths, slugs and table rules are long runs too, but never mix all three.)
 */
function base64Runs(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)]
    .map((m) => m[0])
    .filter((run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run));
}

/** A postgres URL with a password, unless it points at this machine (the local dev setup). */
function postgresWithPassword(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@(\[[^\]]+\]|[^\s/:?]+)/g)) {
    if (!LOOPBACK.has(m[1]!)) bad.push(m[0]);
  }
  return bad;
}

function secretHits(text: string): string[] {
  const hits: string[] = [];
  for (const [name, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(`${name}: ${m[0].slice(0, 12)}…`);
  }
  for (const run of base64Runs(text)) hits.push(`40+ character base64 run: ${run.slice(0, 12)}…`);
  for (const url of postgresWithPassword(text)) hits.push(`postgres URL with a password: ${url}`);
  return hits;
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));
}

/** `## N. Title` sections of LAUNCH.md, in order. */
function launchSections(): Array<{ n: number; title: string; body: string }> {
  const heads = [...launch.matchAll(/^## (\d+)\. (.+)$/gm)];
  return heads.map((h, i) => ({
    n: Number(h[1]),
    title: h[2]!,
    body: launch.slice(h.index!, i + 1 < heads.length ? heads[i + 1]!.index : undefined),
  }));
}

/** SETUP.md's environment table rows: names in the first column and the "Required?" text. */
function setupEnvRows(): Array<{ names: string[]; required: string }> {
  const start = setup.search(/^## \d+\. Environment variables$/m);
  expect(start, "SETUP.md has an 'Environment variables' section").toBeGreaterThanOrEqual(0);
  const rest = setup.slice(start);
  const section = rest.slice(0, rest.slice(3).search(/^## /m) + 3);
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line.split("|").map((c) => c.trim());
      return {
        names: [...cells[1]!.matchAll(/`([A-Z_][A-Z0-9_]*)`/g)].map((m) => m[1]!),
        required: cells[2]!,
      };
    });
}

/** "Required" in SETUP.md's sense: Yes / Production: yes / Before launch / For <feature>. */
const isRequired = (required: string) => /^(Yes|Production: yes|Before launch|For )/.test(required);

/** LAUNCH.md's own settings table (step 4): first-column names per row. */
function launchEnvRows(): Array<{ names: string[]; line: string }> {
  const step4 = launchSections().find((s) => s.n === 4);
  expect(step4, "LAUNCH.md has step 4 (settings)").toBeDefined();
  return step4!.body
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => ({
      names: [...line.split("|")[1]!.matchAll(/`([A-Z_][A-Z0-9_]*)`/g)].map((m) => m[1]!),
      line,
    }));
}

describe("no secret values in the docs", () => {
  it("the patterns catch planted samples (so a typo can't make the check pass silently)", () => {
    // Built at runtime so this file itself never holds a secret-looking string.
    const x = (n: number) => "Ab3".repeat(n);
    const samples = [
      "sk_" + "live_" + x(4),
      "sk_" + "test_" + x(4),
      "whsec" + "_" + x(4),
      "re" + "_" + x(6),
      "sk-" + "ant-" + x(4),
      "AI" + "za" + x(8),
      "GOC" + "SPX-" + x(4),
      "npg" + "_" + x(4),
      "AC" + "0123456789abcdef".repeat(2),
      "-----BEGIN " + "PRIVATE KEY-----",
      "0123456789abcdef".repeat(3),
      x(14),
    ];
    for (const sample of samples) expect(secretHits(`value: ${sample}`), sample).not.toEqual([]);
    expect(postgresWithPassword("postgres://app:" + "hunter2" + "@ep-x.neon.tech/db")).toHaveLength(
      1,
    );
    expect(postgresWithPassword("postgres://sa:sa@localhost:5432/squared_away")).toEqual([]);
    // Placeholders, names, paths and anchors are fine.
    expect(secretHits("`STRIPE_SECRET_KEY` (`sk_test_…` while testing)")).toEqual([]);
    expect(secretHits("#10-optional-text-alerts-and-instant-gmail-notifications")).toEqual([]);
    expect(secretHits("node_modules/next/dist/server/lib/generate-agent-files.js")).toEqual([]);
  });

  it("scans every Markdown file, not just docs/", () => {
    for (const file of [
      "README.md",
      "CLAUDE.md",
      "AGENTS.md",
      "docs/LAUNCH.md",
      "docs/SETUP.md",
      "src/app/_og/README.md",
    ]) {
      expect(DOC_FILES, file).toContain(file);
    }
    expect(DOC_FILES.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it.each(DOC_FILES)("%s has no secret-looking value", (file) => {
    expect(secretHits(readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
  });

  it("LAUNCH.md has no database URL at all and no model ids", () => {
    expect(launch).not.toMatch(/postgres(?:ql)?:\/\//);
    for (const id of Object.values(models)) expect(launch).not.toContain(id);
  });
});

describe("LAUNCH.md links", () => {
  const links = [...launch.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);

  it("has links to check", () => {
    expect(links.length).toBeGreaterThan(10);
  });

  it("every relative link points at a file that exists, and every anchor at a real heading", () => {
    const broken: string[] = [];
    for (const link of links) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [path, anchor] = link.split("#") as [string, string | undefined];
      const target = path ? normalize(join(dirname(LAUNCH_PATH), path)) : LAUNCH_PATH;
      if (!existsSync(target)) {
        broken.push(`${link} (no file ${target})`);
        continue;
      }
      if (anchor && target.endsWith(".md") && !anchors(readFileSync(target, "utf8")).has(anchor)) {
        broken.push(`${link} (no heading #${anchor} in ${target})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("links the docs Davi needs", () => {
    for (const doc of ["SETUP.md", "google-verification.md"]) {
      expect(
        links.some((l) => l.startsWith(doc)),
        doc,
      ).toBe(true);
    }
  });
});

describe("LAUNCH.md covers the settings", () => {
  const rows = setupEnvRows();
  const required = rows.filter((r) => isRequired(r.required)).flatMap((r) => r.names);

  it("finds the required settings in SETUP.md (the parse can't silently find nothing)", () => {
    for (const name of [
      "APP_URL",
      "DATABASE_URL",
      "AUTH_SECRET",
      "AUTH_GOOGLE_ID",
      "AUTH_GOOGLE_SECRET",
      "TOKEN_ENCRYPTION_KEY",
      "ADMIN_EMAIL",
      "SUPPORT_EMAIL",
      "ANTHROPIC_API_KEY",
      "INNGEST_EVENT_KEY",
      "INNGEST_SIGNING_KEY",
      "STRIPE_SECRET_KEY",
    ]) {
      expect(required, name).toContain(name);
    }
  });

  it("mentions every setting SETUP.md marks as required, in its settings table", () => {
    const inTable = new Set(launchEnvRows().flatMap((r) => r.names));
    expect(required.filter((name) => !inTable.has(name))).toEqual([]);
  });

  it("names only settings SETUP.md documents", () => {
    const documented = new Set(rows.flatMap((r) => r.names));
    const unknown = launchEnvRows()
      .flatMap((r) => r.names)
      .filter((name) => !documented.has(name));
    expect(unknown).toEqual([]);
  });

  it("says the test switches, the local Inngest switch and the webhook override never go on Vercel", () => {
    const never = launchEnvRows().filter((r) => r.line.includes("**Never set on Vercel**"));
    const names = new Set(never.flatMap((r) => r.names));
    for (const name of [
      "SA_E2E",
      "SA_E2E_GOOGLE_BASE_URL",
      "SA_E2E_ANTHROPIC_BASE_URL",
      "SA_E2E_HOOK_SECRET",
      "INNGEST_DEV",
      "STRIPE_WEBHOOK_SECRET",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    expect(flat(launch)).toContain("Automatically expose System Environment Variables");
  });
});

describe("LAUNCH.md structure", () => {
  const sections = launchSections();

  it("has steps 0–13 in order, Google verification first", () => {
    expect(sections.map((s) => s.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(sections[0]!.title).toMatch(/^Start now: Google verification/);
    expect(sections[13]!.title).toBe("Decisions waiting on you");
  });

  it("every step (0–12) says how to know it worked", () => {
    for (const s of sections.filter((s) => s.n <= 12)) {
      expect(s.body, `step ${s.n}`).toMatch(/Worked when|How you'll know/);
    }
  });

  it("the Google section covers what gates a launch with restricted scopes", () => {
    const google = flat(sections[0]!.body);
    for (const phrase of [
      "Search Console",
      "Authorized domains",
      "In production",
      "7 days",
      "100",
      "unverified app",
      "CASA",
      "google-verification.md",
      "/privacy",
      "/terms",
    ]) {
      expect(google, phrase).toContain(phrase);
    }
  });

  it("step 0 only starts 0a and 0c before the merge; the rest wait for steps 1 and 5", () => {
    // Production has no /privacy or /terms and none of the demo's screens until the merge, so
    // Branding links, the video, the reviewer and the submission must come after it.
    const google = sections[0]!.body;
    const sub = (id: string) => {
      const m = google.match(new RegExp(`\\*\\*${id}\\. [^\\n]*`));
      expect(m, id).not.toBeNull();
      return m![0];
    };
    expect(sub("0a")).toContain("(Now.)");
    expect(sub("0c")).toContain("(Now.)");
    for (const id of ["0b", "0d"]) expect(sub(id), id).toContain("After steps 1 and 5");
    expect(sub("0e")).toContain("After 0b and 0d");
    expect(flat(google)).toContain("**After [step 1](#1-merge-the-launch-branch) (merge)");
  });

  it("the submission never waits on the reviewer's address (Google only sends it afterwards)", () => {
    const google = sections[0]!.body;
    const heads = [...google.matchAll(/^\*\*(0[a-g])\. ([^*]+)\*\*([^\n]*)$/gm)].map((m) => ({
      id: m[1]!,
      title: m[2]!,
      when: m[3]!,
    }));
    expect(heads.map((h) => h.id)).toEqual(["0a", "0b", "0c", "0d", "0e", "0f", "0g"]);
    const submit = heads.findIndex((h) => h.title.startsWith("Submit for verification"));
    const invite = heads.findIndex((h) => h.title.startsWith("Invite the reviewer"));
    expect(submit, "a submit sub-step").toBeGreaterThanOrEqual(0);
    expect(invite, "an invite sub-step").toBeGreaterThan(submit);
    expect(heads[submit]!.when).not.toContain(heads[invite]!.id);
    expect(heads[invite]!.when).toContain(heads[submit]!.id);
    expect(heads[invite]!.when).toContain("Google's email names the address");
  });

  it("the submission adds the three Gmail scopes on Data Access if they aren't listed", () => {
    const google = flat(sections[0]!.body);
    expect(google).toContain("**Add or remove scopes**");
    expect(google).toContain('"Manually add scopes"');
    for (const scope of Object.values(GMAIL_SCOPES))
      expect(google, scope).toContain(`\`${scope}\``);
  });

  it("publishing tells everyone who connected in Testing to reconnect once (old keys still expire)", () => {
    const google = sections[0]!.body;
    const c = flat(google.slice(google.indexOf("**0c."), google.indexOf("**0d.")));
    expect(c).toContain("**still runs out** 7 days after it was given");
    expect(c).toContain("open `/connect`");
    expect(c).toContain("pick the **same** Gmail address");
    expect(c).toMatch(/Worked when: Audience shows \*\*In production\*\*, and you[^.]*reconnected/);
    const smoke = flat(sections.find((s) => s.n === 12)!.body);
    expect(smoke).toMatch(
      /In production\*\* \(step 0c\)\. The first time after publishing[^.]*reconnected/,
    );
    // SETUP.md's Google section says the same, right after telling him to switch.
    const setupFlat = flat(setup);
    const switchAt = setupFlat.indexOf("Switch it to **In production** before real owners connect");
    expect(switchAt, "SETUP.md's In production sentence").toBeGreaterThanOrEqual(0);
    expect(setupFlat.slice(switchAt, switchAt + 400)).toContain(
      "Access given while it was still Testing keeps its 7-day end, so everyone who connected then reconnects once after the switch (`/connect` → the same address; `docs/LAUNCH.md` step 0c)",
    );
    // True of the code: /connect exists, and the same address replaces the key (no limit hit).
    expect(existsSync(join(ROOT, "src/app/(app)/connect/page.tsx"))).toBe(true);
    const mailboxes = readFileSync(join(ROOT, "src/server/mailboxes.ts"), "utf8");
    expect(mailboxes).toContain("if (!isReconnect && existing.length >= limit)");
  });

  it("the preview step is Davi's choice (an empty sa-preview project) with its own secrets", () => {
    const previews = flat(sections.find((s) => s.n === 2)!.body);
    for (const phrase of [
      // Davi, 2026-10-14: option B, a separate empty Neon project. Copies of production are out.
      "`sa-preview`",
      "**Connection pooling** is on",
      "`-pooler`",
      "type **Secret**, tick **Preview** only",
      "TOKEN_ENCRYPTION_KEY",
      "AUTH_SECRET",
      '"Accounts (1)"',
      // Google allows no wildcard redirect URIs: sign-in only works on a registered branch address.
      "/api/auth/callback/google",
      "/api/gmail/callback",
    ]) {
      expect(previews, phrase).toContain(phrase);
    }
    expect(previews).not.toMatch(/Option A|Neon branches per preview|preview branching/);
    // Who does what: Davi creates the project and pastes the string; the engineers untick Preview
    // on the shared entry (a target-only change) and add the Preview-only secrets.
    const step2 = sections.find((s) => s.n === 2)!.body;
    const sub = (id: string) =>
      flat(step2.slice(step2.indexOf(`**${id}.`)).split(/\n\*\*2[a-e]\./)[0]!);
    expect(sub("2a")).toContain("(you, in Neon");
    expect(sub("2b")).toContain("(you, in Neon)");
    expect(sub("2c")).toContain("(the engineers)");
    expect(sub("2c")).toContain("production's value isn't touched");
    expect(sub("2d")).toContain("(you, in Vercel)");
    expect(sub("2e")).toContain("(the engineers)");
    // True of the code: /admin counts accounts in its heading.
    const admin = readFileSync(join(ROOT, "src/app/(app)/admin/page.tsx"), "utf8");
    expect(admin).toMatch(/Accounts \(\{/);
  });

  it("the preview step splits the shared entries and never edits or deletes production's", () => {
    // Production and Preview share one Vercel entry for these; deleting it or changing its value
    // would break production (new key = every owner reconnects; new DB = empty production).
    const previews = flat(sections.find((s) => s.n === 2)!.body);
    for (const phrase of [
      "How to split a setting",
      "Untick **Preview** only",
      "leave the value alone",
      "**Add New**",
      "never delete those entries and never change their values",
    ]) {
      expect(previews, phrase).toContain(phrase);
    }
    expect(previews).not.toMatch(/delete the \*\*Preview\*\* `DATABASE_URL`/);
    expect(previews).not.toMatch(/edit the \*\*Preview\*\*/);
    expect(flat(sections.find((s) => s.n === 4)!.body)).toContain("**two separate rows**");
  });

  it("the domain change adds Google's redirect addresses before APP_URL, then redirects the old one", () => {
    const step5 = sections.find((s) => s.n === 5)!.body;
    // Google refuses a redirect address on a domain that isn't an authorized domain yet.
    const authorized = step5.indexOf("**Branding** → Authorized domains → **Add domain**");
    const google = step5.indexOf("Authorized redirect URIs");
    const appUrl = step5.indexOf("`APP_URL` (Production only)");
    expect(authorized).toBeGreaterThan(0);
    expect(google).toBeGreaterThan(authorized);
    expect(appUrl).toBeGreaterThan(google);
    expect(flat(step5)).toContain("**Redirect to** your domain");
    expect(flat(step5)).not.toContain("Keep the old address working");
  });

  it("going live taps the button the page shows, and doesn't count the old Connected line as proof", () => {
    const step7 = sections.find((s) => s.n === 7)!.body;
    const c = flat(step7.slice(step7.indexOf("**7c."), step7.indexOf("**7d.")));
    // Test mode was connected first, so the button already reads "Connect Stripe again".
    expect(c).toContain("Payments → **Connect Stripe again**");
    expect(c).not.toMatch(/\*\*Connect Stripe\*\*/);
    expect(c).toContain('"Connected · last set up …" line was already there from test mode');
    expect(c).toContain("proves nothing");
    const admin = readFileSync(join(ROOT, "src/app/(app)/admin/page.tsx"), "utf8");
    expect(admin).toContain('{stripeAt ? "Connect Stripe again" : "Connect Stripe"}');
    expect(admin).toContain("Connected · last set up ${");
    expect(admin).toContain('stripe: "Couldn\'t connect Stripe."');
    expect(c).toContain('"Couldn\'t connect Stripe."');
  });

  it("going live: swap the key, then reset test payments, then Connect Stripe again", () => {
    const step7 = flat(sections.find((s) => s.n === 7)!.body);
    const swap = step7.indexOf("**7a. Swap the key.**");
    const reset = step7.indexOf("**7b. Reset test payments.**");
    const connect = step7.indexOf("**7c. Connect Stripe.**");
    expect(swap).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(swap);
    expect(connect).toBeGreaterThan(reset);
    const b = step7.slice(reset, connect);
    expect(b).toContain("Payments → **Check test payments**");
    expect(b).toContain("**Reset test payments** → **Yes, reset test payments**");
    expect(b).toContain('"Test payments reset for N accounts."');
    expect(b).toContain("Worked when:");
    expect(step7).not.toContain("There is no button for it on purpose");
    // The step 13 entry points at the reset, not the key swap.
    expect(flat(sections[13]!.body)).toContain("([step 7b](#7-stripe-live-mode))");
    // After Connect Stripe and the test-mode clean-up, one more check: nothing came back.
    const c = step7.slice(connect, step7.indexOf("**7d."));
    const recheck = c.indexOf("Payments → **Check test payments** once more");
    expect(recheck).toBeGreaterThan(c.indexOf("test mode's Webhooks page lists no endpoint"));
    expect(c.slice(recheck)).toContain('Worked when: the card reads "Test payments: none left."');
    // True of the code: with the live key, test-mode webhook events change nothing.
    const billing = readFileSync(join(ROOT, "src/server/billing.ts"), "utf8");
    expect(billing).toContain("if (eventFromOtherMode(event.livemode, stripeMode())) {");
  });

  it("sales tax: prices fixed first, and 'on' isn't counted as proof without registrations", () => {
    const step7 = sections.find((s) => s.n === 7)!.body;
    const e = flat(step7.slice(step7.indexOf("**7e."), step7.indexOf("**7f.")));
    // Davi, 2026-10-14: Massachusetts first (Stripe can't register a seller in its home state),
    // then Connect Stripe makes the prices exclusive whether or not tax is on: before the tax
    // settings, and the Stripe registration last.
    const state = e.indexOf("**Register with Massachusetts first.**");
    const connect = e.indexOf("**Connect Stripe again**");
    const settings = e.indexOf("Settings → **Tax**");
    const registrations = e.indexOf("Tax → **Locations**");
    expect(state).toBeGreaterThan(0);
    expect(connect).toBeGreaterThan(state);
    expect(settings).toBeGreaterThan(connect);
    expect(registrations).toBeGreaterThan(settings);
    for (const phrase of [
      "MassTaxConnect",
      "`txcd_10103001`",
      "`txcd_20120002`",
      "**Exclusive**",
      "**I've already registered**",
      "$0 tax and warns about nothing",
      "0.5%",
      "within 30 days after its period ends",
    ]) {
      expect(e, phrase).toContain(phrase);
    }
    // Stripe's "active" only needs the business address; tax is charged only where registered.
    const worked = e.slice(e.indexOf("Worked when:", e.indexOf("**Start collecting**")));
    expect(worked).toContain('"Sales tax: on (Stripe Tax is set up)." **and**');
    expect(worked).toContain('Tax → Locations shows Massachusetts as "Collecting tax"');
    // The questions for an accountant are listed once.
    expect(flat(launch).split("Questions for your accountant").length - 1).toBe(1);
    const s5 = flat(setup.slice(setup.indexOf("5. Sales tax"), setup.indexOf("What payments do:")));
    expect(s5).not.toContain("until the status reads active");
    expect(s5.indexOf("MassTaxConnect")).toBeLessThan(s5.indexOf("**Connect Stripe again**"));
    expect(s5.indexOf("**Connect Stripe again**")).toBeLessThan(s5.indexOf("Settings → Tax"));
    expect(s5).toContain('Tax → Locations shows Massachusetts as "Collecting tax"');
    expect(flat(setup)).not.toContain("Customer portal → Customer information");
    // …and the admin card says the same under "on".
    const admin = readFileSync(join(ROOT, "src/app/(app)/admin/page.tsx"), "utf8");
    expect(admin).toContain('{salesTax === "on" ? <p>{SALES_TAX_ON_NOTE}</p> : null}');
    expect(SALES_TAX_ON_NOTE).toContain("Tax → Registrations");
  });

  it("the 'never change' rule names both planned changes in step 3 (the Neon password too)", () => {
    const step3 = flat(sections.find((s) => s.n === 3)!.body);
    expect(step3).toMatch(/Reset password[\s\S]*`DATABASE_URL` \(Production/);
    expect(step3).toContain("`AUTH_GOOGLE_SECRET`");
    const step2 = flat(sections.find((s) => s.n === 2)!.body);
    expect(step2).toContain(
      "apart from the two planned changes in [step 3](#3-change-the-passwords-that-were-pasted-in-chat) (the new Neon password changes `DATABASE_URL`, the new Google client secret changes `AUTH_GOOGLE_SECRET`)",
    );
    const step4 = flat(sections.find((s) => s.n === 4)!.body);
    expect(step4).toContain(
      "except the two planned changes in step 3: the new Neon password (a new `DATABASE_URL`) and the new Google client secret (a new `AUTH_GOOGLE_SECRET`)",
    );
    expect(step4).not.toContain("except the planned Google secret change in step 3");
  });

  it("Stripe live mode removes the test-mode endpoint; the Neon reset warns of the outage", () => {
    const step7 = flat(sections.find((s) => s.n === 7)!.body);
    expect(step7).toMatch(/turn \*\*Test mode\*\* on → Developers → Webhooks[^.]*\*\*Delete\*\*/);
    const step3 = flat(sections.find((s) => s.n === 3)!.body);
    expect(step3).toContain("quiet hour");
    expect(step3).toContain("doesn't touch the database");
  });

  it("the Gmail draft check runs before the merge (the clean-up zeroes it afterwards)", () => {
    const step1 = flat(sections.find((s) => s.n === 1)!.body);
    expect(step1).toContain("Gmail draft check");
    expect(step1).toContain("before** the merge");
    expect(step1).toMatch(/join messages m[\s\S]*sent_gmail_message_id/);
    expect(flat(sections[13]!.body)).toContain("run it **before merging**");
  });

  it("the referral decision in step 13 matches the committed config", () => {
    const pricing = readFileSync(join(ROOT, "src/config/pricing.ts"), "utf8");
    expect(pricing).toMatch(/REFERRAL_CREDIT_TO\b[^=]*=\s*"referrer"/);
    expect(flat(sections[13]!.body)).toContain("referrer only");
  });

  /** Step 13's three parts: what's decided, what's open, and what Davi still has to hand over. */
  function step13Parts() {
    const body = sections[13]!.body;
    const decided = body.indexOf("### Decided on 2026-10-14");
    const open = body.indexOf("### Still open");
    const needed = body.indexOf("### Still needed from you");
    expect(decided, "a Decided part").toBeGreaterThan(0);
    expect(open, "a Still open part after it").toBeGreaterThan(decided);
    expect(needed, "a Still needed part last").toBeGreaterThan(open);
    return {
      decided: flat(body.slice(decided, open)),
      open: flat(body.slice(open, needed)),
      needed: flat(body.slice(needed)),
    };
  }

  it("the decisions list carries every open question", () => {
    const { open } = step13Parts();
    for (const phrase of [
      "Neon plan",
      "#47",
      "FEATURE_REFERRALS",
      "referral-fingerprint line",
      "PDF quotes",
      "Growth",
      "[To confirm]",
      "option A for each",
      "I agree to the Terms",
      "lawyer",
      "demo video",
      "gmail.send",
      "CASA",
      "Deleted owners",
      "Option B (new)",
      "Gmail draft check",
    ]) {
      expect(open, phrase).toContain(phrase);
    }
  });

  it("Davi's 2026-10-14 decisions are recorded as decided, not asked again", () => {
    const { decided, open } = step13Parts();
    for (const phrase of [
      "Merge and deploy",
      "`sa-preview`",
      "Test-mode Stripe accounts",
      "**Reset test payments**",
      "Stripe Tax",
      "#26 closing question",
      "`FEATURE_CLOSING_QUESTION` to `1` in Vercel (Production and Preview)",
      "all seven services",
      '"Big words"',
    ]) {
      expect(decided, phrase).toContain(phrase);
    }
    for (const settled of [
      "Test-mode Stripe accounts",
      "FEATURE_CLOSING_QUESTION",
      "option B (an empty preview project)",
      "confirm all seven services",
    ]) {
      expect(open, settled).not.toContain(settled);
    }
    // #26 is on in Vercel; the code default stays off (the env var is the switch).
    const features = readFileSync(join(ROOT, "src/config/features.ts"), "utf8");
    expect(features).toContain("Turned on by Davi 2026-10-14");
    expect(features).not.toMatch(/closing[^\n]*ASK DAVI/i);
  });

  it("the referral amount options are listed, with the ones that need more code marked", () => {
    const { open } = step13Parts();
    for (const option of ["A $50", "B $99", "C $199", "D $250", "E one free month", "F like E"]) {
      expect(open, option).toContain(option);
    }
    expect(open).toContain("E and F need code beyond what's built today");
  });

  it("the still-needed list keeps every hand-over item", () => {
    const { needed } = step13Parts();
    for (const phrase of [
      "production domain",
      "`SUPPORT_EMAIL`",
      "icon pack",
      "your photo and the exact license wording",
      "`ANTHROPIC_API_KEY` repository secret",
      "Massachusetts sales tax registration",
      "Neon plan check",
      "`sa-preview` Neon project",
      "phone-notification keys",
    ]) {
      expect(needed, phrase).toContain(phrase);
    }
  });

  it("the Neon plan check comes before step 0 and says where to look and what it costs", () => {
    const at = launch.indexOf("## Check your Neon plan now (this week)");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(launch.indexOf("## 0. "));
    const neon = flat(launch.slice(at, launch.indexOf("## 0. ")));
    for (const phrase of ["**Billing**", "**Usage** box", "100 CU-hours", "$19–20 a month"]) {
      expect(neon, phrase).toContain(phrase);
    }
    expect(neon).toMatch(/Worked when/);
    // True of the code: the poll that keeps the database awake runs every 5 minutes.
    const functions = readFileSync(join(ROOT, "src/jobs/functions.ts"), "utf8");
    expect(functions).toContain('"*/5 * * * *"');
  });

  it("SQL it asks Davi to run reads counts or setting names only", () => {
    const blocks = [...launch.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.toLowerCase());
    expect(blocks.length).toBeGreaterThan(0);
    for (const sql of blocks) {
      expect(sql).toMatch(/^\s*select\b/);
      expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/);
      expect(sql).not.toMatch(/select\s+\*|\.\*/);
      // Nothing that would print an email, a name or email text.
      expect(sql).not.toMatch(/\b(body_text|snippet|subject|from_address|email|name|value)\b/);
      const selectList = sql.slice(sql.indexOf("select") + 6, sql.indexOf("from"));
      expect(selectList.trim() === "key" || /^(\s*count\(\*\)[^,]*,?)+\s*$/.test(selectList)).toBe(
        true,
      );
    }
  });
});

describe("what LAUNCH.md tells Davi to look for is what the code shows", () => {
  const code = [...sourceFiles(SRC)].map((f) => readFileSync(f, "utf8")).join("\n");

  it("the screens' wording", () => {
    const trialLabel = sendingOffLabel({
      status: "evaluating",
      evaluationEndsAt: new Date(Date.now() + 86_400_000),
      setupPaidVia: null,
    } as never);
    expect(trialLabel).toBe("Sending is off during your three days");
    expect(flat(launch)).toContain(trialLabel);
    for (const text of [
      "Stripe connected in LIVE mode. Real cards will be charged.",
      "Connect Stripe again",
      "Background jobs look stopped",
      "Payment received — finishing up.",
      "Text me a code",
      "Yes, through Stripe",
      "Couldn't connect Stripe.",
      "Reconnect Gmail",
      // The house-account move (0d): the demo's send part needs a workspace that can send.
      "Use as my own test account",
      "Yes, this is my account",
      "Your account can send now (marked as your own test account).",
      "Your own test account",
      // Reset test payments (7b, Davi 2026-10-14).
      "Check test payments",
      "Reset test payments",
      "Yes, reset test payments",
      "Reset test payments shows up after you switch Stripe to live mode.",
      "Test payments: none left.",
      "Test payments reset for ",
      "Couldn't check ",
      "Tap again.",
    ]) {
      expect(flat(launch), `LAUNCH.md quotes "${text}"`).toContain(text);
      expect(code, `the app shows "${text}"`).toContain(text);
    }
  });

  it("the demo video step makes Davi's workspace the house account first (the only way it can send)", () => {
    const google = sections0();
    const d = flat(google.slice(google.indexOf("**0d."), google.indexOf("**0e.")));
    expect(d).toContain(
      "`/admin` → your own card (always shown first) → **Use as my own test account** → **Yes, this is my account**",
    );
    // True of the code: that move is the only one that sets "house", and only for Davi's own card.
    const lifecycle = readFileSync(join(ROOT, "src/server/workspace-lifecycle.ts"), "utf8");
    expect(lifecycle).toMatch(
      /case "house_account": \{[\s\S]*?isAdminEmail[\s\S]*?setupPaidVia: "house"/,
    );
    const admin = readFileSync(join(ROOT, "src/app/(app)/admin/page.tsx"), "utf8");
    expect(admin).toContain('(m !== "house_account" || (own && w.setupPaidVia !== "house"))');
  });

  it("the one-time clean-up keys it asks about are the real ones", () => {
    const backfill = readFileSync(join(ROOT, "src/server/m7-backfill.ts"), "utf8");
    const cleanup = readFileSync(join(ROOT, "src/server/draft-message-cleanup.ts"), "utf8");
    expect(backfill).toContain('M7_BACKFILL_KEY = "backfill:m7-v1"');
    expect(cleanup).toContain('DRAFT_MESSAGES_CLEANUP_KEY = "cleanup:draft-messages-v1"');
    expect(launch).toContain("'backfill:m7-v1'");
    expect(launch).toContain("'cleanup:draft-messages-v1'");
  });

  it("the background jobs it names exist", () => {
    const functions = readFileSync(join(ROOT, "src/jobs/functions.ts"), "utf8");
    const ids = new Set([...functions.matchAll(/\bid: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
    for (const id of [
      "purge-expired-bodies",
      "workspace-lifecycle",
      "followup-scan",
      "morning-digest",
      "renew-gmail-watches",
    ]) {
      expect(ids.has(id), id).toBe(true);
      expect(launch, id).toContain(id);
    }
  });

  it("the routes and screens it sends Davi to exist", () => {
    for (const path of [
      "src/app/api/health/route.ts",
      "src/app/api/stripe/webhook/route.ts",
      "src/app/api/gmail/callback/route.ts",
      "src/app/api/gmail/push/route.ts",
      "src/app/api/auth/[...nextauth]/route.ts",
      "src/app/(app)/admin/page.tsx",
      "src/app/privacy/page.tsx",
      "src/app/terms/page.tsx",
    ]) {
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
  });
});
