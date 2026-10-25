import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { parseText, rel, ROOT, sourceFiles, ts, walk } from "../support/source-ast";

/**
 * Check 5 P1 + Check 2 P5: Squared Away Growth never uses anyone's inbox, not even as a count
 * (Google's Limited Use rules cover data "aggregated, anonymized, or derived" from Gmail, and the
 * Growth page promises it: growth-copy.ts "Your email stays out of it" and the FAQ). This reads the
 * source and fails when:
 *  - a file in the signed-in app, server, jobs or lib code starts mentioning Growth without being
 *    added to MENTIONS on purpose (with a comment);
 *  - a file that mentions Growth reads inbox modules or tables;
 *  - Growth's own code imports inbox modules or tables;
 *  - server code outside the waitlist imports Growth's modules;
 *  - billing, digest, monthly summary or alert content mentions Growth;
 *  - GrowthMention grows a prop (anything it showed could then depend on the owner's mail).
 *
 * Extending it: a new Growth file (the client portal, say) goes in GROWTH_PATHS, plus MENTIONS if
 * it lives under one of the SCANNED folders. Both lists are meant to be added to, with a reason.
 */

const SCANNED = ["src/app/(app)", "src/server", "src/jobs", "src/lib", "src/components/app"];
const MENTION = /\/growth\b|growthCopy|Squared Away Growth/;

/** Files under SCANNED allowed to mention Growth, each with why. */
const MENTIONS: Record<string, string> = {
  "src/app/(app)/admin/page.tsx": "Davi's own waitlist card lists Growth call requests",
  "src/app/(app)/admin/actions.ts": "admin waitlist actions (a Growth-only row is never invited)",
  "src/server/growth.ts": "the Growth call-request form and Davi's notification",
  "src/server/growth-note.ts": "how a Growth request is stored on a waitlist row",
  "src/server/waitlist.ts": "the shared waitlist table holds Growth requests too",
  "src/server/waitlist-emails.ts": "the waitlist confirmation email",
  "src/server/source-rules.ts": "where a sign-up came from (the /growth page is one source)",
  "src/lib/landing-source.ts": "first-touch landing page, /growth included",
  "src/lib/analytics-rules.ts": "page-view analytics counts /growth",
  // Check 1 P6: the post-deploy header check names the public paths, /growth among them.
  "src/lib/check-headers-rules.ts": "the noindex check lists the public pages (/growth is one)",
  "src/lib/structured-data.ts":
    "/growth's search-engine Service block (Check 33 P2): growthCopy and the service labels only",
  "src/components/app/growth-mention.tsx": "the one static app mention (no props)",
  "src/components/app/site-footer.tsx":
    "the public pages' static footer link (/, /signin, /not-invited, /goodbye, legal pages)",
  // Growth client portal (integration 2026-10-17): Davi-entered numbers only.
  "src/app/(app)/more/page.tsx":
    "places GrowthMention (hidden when read-only or expired) and a client's /my-growth link",
  "src/app/(app)/admin/growth/page.tsx": "/admin/growth: Davi's Growth clients page",
  "src/app/(app)/admin/growth-actions.ts": "/admin/growth's actions (clients, updates, numbers)",
  "src/app/(app)/admin/growth-admin.tsx": "/admin/growth's forms and lists",
  "src/server/growth-client-rules.ts": "the portal's pure rules (months, numbers, words)",
  "src/server/growth-clients.ts": "the portal's reads and writes (growth_* tables, invites)",
  "src/server/accounts.ts":
    "first sign-in calls linkGrowthInvite (invites row → growth_clients; no inbox data)",
};

/** Growth's own code (Check 2 P5). The client portal's files are added here when it merges. */
const GROWTH_PATHS = [
  "src/server/growth.ts",
  "src/server/growth-note.ts",
  "src/app/growth-actions.ts",
  "src/app/growth/",
  "src/components/marketing/growth/",
  "src/components/app/growth-mention.tsx",
  // The client portal: /start, /my-growth and /admin/growth, and what they read.
  "src/server/growth-client-rules.ts",
  "src/server/growth-clients.ts",
  "src/app/start/page.tsx",
  "src/app/my-growth/page.tsx",
  "src/app/(app)/admin/growth/page.tsx",
  "src/app/(app)/admin/growth-actions.ts",
  "src/app/(app)/admin/growth-admin.tsx",
  "src/components/growth-portal/portal-copy.ts",
];

/** Server files that may import Growth's modules. */
const MAY_IMPORT_GROWTH = new Set([
  "src/server/growth.ts",
  "src/server/growth-note.ts",
  "src/server/waitlist.ts",
  "src/server/waitlist-emails.ts",
  "src/server/account-deletion.ts",
  // The portal reuses how a Growth request is stored on a waitlist row (inviting from it).
  "src/server/growth-clients.ts",
  // First sign-in links a Growth invite to the new workspace (linkGrowthInvite).
  "src/server/accounts.ts",
]);

/**
 * Referral code Growth's own files may import (plan #47, Davi 2026-10-16: "a Growth request can
 * earn a referral"), name by name, each with why. Nothing else from the referral modules.
 */
const GROWTH_MAY_IMPORT_REFERRAL: Record<string, Record<string, string>> = {
  "@/server/referrals": {
    creditGrowthReferralSafely:
      "settles a referral when Davi makes someone a client (startGrowth / linkGrowthInvite); " +
      "reads the owner's email, the waitlist row's code, growth_clients and referral rows only",
  },
  "@/server/referral-rules": {
    isReferralCode: "format check of a referral link's code on the Growth call form (pure)",
    referralsVisible: "the code is kept only while referrals are switched on (pure)",
  },
};

/** Inbox modules: anything that reads mail, drafts, the AI, jobs or the owner's numbers. */
const INBOX_MODULES = [
  "@/mailbox",
  "@/ai",
  "@/jobs",
  "@/server/sync",
  "@/server/classification",
  "@/server/inbox",
  "@/server/drafts",
  "@/server/voice",
  "@/server/quotes",
  "@/server/customers",
  "@/server/followups",
  "@/server/digest",
];
/** Tables that hold inbox content or anything derived from it. */
const INBOX_TABLES = new Set([
  "threads",
  "messages",
  "drafts",
  "mailboxes",
  "classifications",
  "voiceProfile",
  "voiceProfiles",
  "businessProfile",
  "businessProfiles",
  "usage",
  "activityLog",
]);
/** The same tables named in raw SQL. */
const INBOX_SQL =
  /\b(?:from|join|into|update)\s+"?(?:threads|messages|drafts|mailboxes|voice_profile|business_profile|usage|activity_log)\b/i;

/** Billing, digest, monthly-summary, alert and text-message content: never a Growth mention. */
const NEVER_MENTION = [
  "src/app/(app)/billing/",
  "src/server/digest",
  "src/server/monthly-summary.ts",
  "src/server/alerts.ts",
  "src/server/sms-alerts.ts",
  "src/server/push-alerts.ts",
  "src/server/lifecycle.ts",
  "src/server/workspace-lifecycle.ts",
  // Integration 2026-10-17: the trial emails, first-week emails and emergency alerts too.
  "src/server/trial-email",
  "src/server/first-week.ts",
  "src/server/emergency-alert",
];

const ALL = sourceFiles().map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));
const under = (file: string, prefix: string) =>
  prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix || file.startsWith(prefix);

/** Every module a file imports or re-exports (relative paths turned into "@/…"), with names. */
function importsOf(file: string, text: string): Array<{ module: string; names: string[] }> {
  const sf = parseText(file, text);
  const out: Array<{ module: string; names: string[] }> = [];
  const norm = (spec: string) => {
    if (!spec.startsWith(".")) return spec;
    const abs = join(ROOT, dirname(file), spec);
    return "@/" + rel(abs).replace(/^src\//, "");
  };
  walk(sf, (n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const names: string[] = [];
      walk(n, (x) => {
        if (ts.isImportSpecifier(x) || ts.isExportSpecifier(x)) {
          names.push((x.propertyName ?? x.name).getText());
        }
        if (ts.isNamespaceImport(x)) names.push("*");
      });
      out.push({ module: norm(n.moduleSpecifier.text), names });
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      out.push({ module: norm(n.arguments[0].text), names: ["*"] });
    }
  });
  return out;
}

/** Why a file touches the inbox, or [] when it doesn't. */
function inboxTouches(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const imp of importsOf(file, text)) {
    if (INBOX_MODULES.some((m) => imp.module === m || imp.module.startsWith(m + "/"))) {
      hits.push(`imports ${imp.module}`);
    }
    if (imp.module === "@/db/schema") {
      for (const name of imp.names) {
        if (name === "*" || INBOX_TABLES.has(name)) hits.push(`imports ${name} from @/db/schema`);
      }
    }
  }
  if (INBOX_SQL.test(text)) hits.push(`names an inbox table in SQL (${text.match(INBOX_SQL)![0]})`);
  return hits;
}

describe("Growth never touches inbox data (Check 5 P1 + Check 2 P5)", () => {
  it("only the listed files in the app, server, jobs and lib code mention Growth", () => {
    const mentioning = ALL.filter(
      (f) => SCANNED.some((d) => f.file.startsWith(d + "/")) && MENTION.test(f.text),
    ).map((f) => f.file);
    expect(mentioning.filter((f) => !(f in MENTIONS))).toEqual([]);
    expect(mentioning.length).toBeGreaterThanOrEqual(5);
    for (const file of Object.keys(MENTIONS)) {
      expect(
        ALL.some((f) => f.file === file),
        `${file} (in MENTIONS) exists`,
      ).toBe(true);
    }
  });

  it("files that mention Growth (other than the admin page) don't read inbox modules or tables", () => {
    const bad = Object.keys(MENTIONS)
      .filter((file) => file !== "src/app/(app)/admin/page.tsx")
      .flatMap((file) => {
        const f = ALL.find((x) => x.file === file);
        return f ? inboxTouches(f.file, f.text).map((why) => `${file} ${why}`) : [];
      });
    expect(bad).toEqual([]);
  });

  it("the admin page's Growth card gets only waitlist rows (no workspace or mailbox fields)", () => {
    const page = ALL.find((f) => f.file === "src/app/(app)/admin/page.tsx")!;
    const sf = parseText(page.file, page.text);
    let props: string[] | null = null;
    let rowType = "";
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "WaitlistEntry") {
        const type = n.parameters[0]?.type;
        if (type && ts.isTypeLiteralNode(type)) {
          props = type.members.map((m) => m.name?.getText() ?? "");
          const w = type.members.find((m) => m.name?.getText() === "w");
          rowType = w && ts.isPropertySignature(w) ? (w.type?.getText() ?? "") : "";
        }
      }
    });
    expect(props, "WaitlistEntry's props").not.toBeNull();
    expect(props!.filter((p) => /workspace|mailbox|thread|message|draft/i.test(p))).toEqual([]);
    // The row comes from listWaitlist, which reads only the waitlist, invites and users tables.
    expect(rowType).toContain("listWaitlist");
    const waitlist = ALL.find((f) => f.file === "src/server/waitlist.ts")!.text;
    const body = waitlist.slice(
      waitlist.indexOf("export async function listWaitlist"),
      waitlist.indexOf("\n}\n", waitlist.indexOf("export async function listWaitlist")),
    );
    expect(body.length).toBeGreaterThan(100);
    expect(body).not.toMatch(/\b(workspaces|mailboxes|threads|messages|drafts)\b/);
  });

  it("GrowthMention takes no props", () => {
    const file = "src/components/app/growth-mention.tsx";
    const sf = parseText(file, ALL.find((f) => f.file === file)!.text);
    const exported: Array<{ name: string; params: number }> = [];
    walk(sf, (n) => {
      if (
        ts.isFunctionDeclaration(n) &&
        n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.push({ name: n.name?.text ?? "", params: n.parameters.length });
      }
    });
    expect(exported).toEqual([{ name: "GrowthMention", params: 0 }]);
    // Its line is static copy, the same for every owner.
    expect(growthCopy.appMention.line).toContain("Nothing from your email is used for it.");
  });

  it("billing, digest, monthly summary, alerts and lifecycle never mention Growth", () => {
    const bad = ALL.filter(
      (f) => NEVER_MENTION.some((p) => under(f.file, p)) && /\/growth\b|growthCopy/.test(f.text),
    ).map((f) => f.file);
    expect(bad).toEqual([]);
    // The scan reaches those files.
    for (const p of ["src/app/(app)/billing/", "src/server/digest", "src/server/alerts.ts"]) {
      expect(
        ALL.some((f) => under(f.file, p)),
        p,
      ).toBe(true);
    }
  });

  it("Growth's own code imports no inbox module or table", () => {
    const growthFiles = ALL.filter((f) => GROWTH_PATHS.some((p) => under(f.file, p)));
    expect(growthFiles.length).toBeGreaterThanOrEqual(8);
    const bad = growthFiles.flatMap((f) =>
      inboxTouches(f.file, f.text).map((why) => `${f.file} ${why}`),
    );
    expect(bad).toEqual([]);
  });

  it("Growth's own code imports only the listed referral names", () => {
    const growthFiles = ALL.filter((f) => GROWTH_PATHS.some((p) => under(f.file, p)));
    const bad = growthFiles.flatMap((f) =>
      importsOf(f.file, f.text)
        .filter((i) => /^@\/server\/referral/.test(i.module))
        .flatMap((i) => {
          const allowed = GROWTH_MAY_IMPORT_REFERRAL[i.module] ?? {};
          return i.names
            .filter((n) => !(n in allowed))
            .map((n) => `${f.file} imports ${n} from ${i.module}`);
        }),
    );
    expect(bad).toEqual([]);
    // The hooks are really there (a referral settles when someone becomes a client).
    const clients = ALL.find((f) => f.file === "src/server/growth-clients.ts")!.text;
    expect(clients.match(/creditGrowthReferralSafely\(/g)?.length).toBe(2);
  });

  it("the Growth referral settle reads no inbox data", () => {
    const text = ALL.find((f) => f.file === "src/server/referrals.ts")!.text;
    const body = (name: string) => {
      const at = text.indexOf(`export async function ${name}(`);
      expect(at, name).toBeGreaterThan(0);
      return text.slice(at, text.indexOf("\n}\n", at));
    };
    for (const name of ["creditGrowthReferral", "creditGrowthReferralSafely"]) {
      expect(body(name)).not.toMatch(
        /\b(threads|messages|drafts|mailboxes|businessProfile|voiceProfile|usage|rules)\b/,
      );
    }
    // settleOnce (shared with the app door) writes the referral row and the referrer's own
    // Activity line, and reads nothing from anyone's inbox.
    const settle = text.slice(
      text.indexOf("async function settleOnce("),
      text.indexOf("\n}\n", text.indexOf("async function settleOnce(")),
    );
    expect(settle.length).toBeGreaterThan(100);
    expect(settle).not.toMatch(
      /\b(threads|messages|drafts|mailboxes|businessProfile|voiceProfile|usage)\b/,
    );
    expect(settle).not.toMatch(/\.select\(\)\s*\.from\(activityLog\)|from\(activityLog\)/);
  });

  it("server code outside the waitlist doesn't import Growth's modules", () => {
    const bad = ALL.filter(
      (f) => f.file.startsWith("src/server/") && !MAY_IMPORT_GROWTH.has(f.file),
    ).flatMap((f) =>
      importsOf(f.file, f.text)
        .filter((i) =>
          [
            "@/server/growth",
            "@/server/growth-note",
            "@/server/growth-clients",
            "@/server/growth-client-rules",
          ].includes(i.module),
        )
        .map((i) => `${f.file} imports ${i.module}`),
    );
    expect(bad).toEqual([]);
  });

  it("self-test: the scanner catches inbox imports next to Growth code", () => {
    const fixture = [
      'import { threads } from "@/db/schema";',
      'import { growthCopy } from "@/components/marketing/growth/growth-copy";',
      'import { listQueue } from "../server/drafts";',
      'import * as schema from "@/db/schema";',
      "const n = await db().execute(sql`select count(*) from threads`);",
    ].join("\n");
    const hits = inboxTouches("src/lib/growth-fixture.ts", fixture);
    expect(hits).toEqual([
      "imports threads from @/db/schema",
      "imports @/server/drafts",
      "imports * from @/db/schema",
      "names an inbox table in SQL (from threads)",
    ]);
    expect(MENTION.test(fixture)).toBe(true);
    expect(inboxTouches("src/server/growth.ts", 'import { waitlist } from "@/db/schema";')).toEqual(
      [],
    );
  });
});
