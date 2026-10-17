import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { drafts, messages, priceHistory, threads, usage } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { adminOverview, listInvites, systemHealth } from "@/server/admin";
import { costRows } from "@/server/admin-costs";
import {
  countGrowthClients,
  growthAccountChoices,
  growthStateForEmails,
  listGrowthAdmin,
  postGrowthUpdate,
  saveGrowthMonth,
  startGrowth,
} from "@/server/growth-clients";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { lastTestPaymentsResult } from "@/server/test-payments";
import { createTestDb } from "../support/db";
import { parseText, ts, walk } from "../support/source-ast";

/**
 * Check 16 P11: /admin never shows email content or customer details. Every admin reader is run
 * against a workspace whose threads, messages, drafts and price memory are full of SECRET text,
 * and a static guard refuses the content columns in the admin code. Nothing is allow-listed: if
 * a real need appears later, this test must be changed on purpose.
 * (The older scan in lifecycle.test.ts covers adminOverview only.)
 */

const T0 = new Date("2026-10-01T15:00:00Z");
const NOW = new Date("2026-10-01T18:00:00Z");
const LEAK = /SECRET|secret-customer|Zelda/;

describe("admin readers return no email content (Check 16 P11)", () => {
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const database = await createTestDb();
    const { workspace: w } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const mailboxId = (
      await saveConnectedMailbox(w, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "g1",
        subject: "SECRET-SUBJECT",
        summary: "SECRET-SUMMARY",
        category: "quote_request",
        extracted: { service_requested: "SECRET-EXTRACTED", customer: "Zelda" },
        classifiedAt: T0,
        lastMessageAt: T0,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: "g1-m1",
      direction: "in",
      fromAddress: "secret-customer@x.com",
      fromName: "SECRET Zelda",
      subject: "SECRET-SUBJECT",
      snippet: "SECRET-SNIPPET",
      bodyText: "SECRET-BODY please quote",
      sentAt: T0,
      classifiedAt: T0,
    });
    await database.insert(drafts).values({
      threadId: t!.id,
      mailboxId,
      kind: "reply",
      gmailDraftId: "gd1",
      toAddress: "secret-customer@x.com",
      subject: "Re: SECRET-SUBJECT",
      body: "SECRET-DRAFT",
      originalBody: "SECRET-ORIGINAL",
      status: "pending",
      reason: "SECRET-REASON",
      flags: [],
      confidence: 90,
      promptVersion: "draft.v1",
      createdAt: T0,
    });
    await database.insert(priceHistory).values({
      workspaceId: w.id,
      threadId: t!.id,
      service: "SECRET-SERVICE",
      amountCents: 4242400,
      quotedAt: T0,
    });
    // Enough AI cost that the cost page shows the account (and its alert).
    await database.insert(usage).values({
      workspaceId: w.id,
      period: "2026-10-01",
      aiCalls: 900,
      estimatedCostCentiCents: 9_000_000,
    });
  });

  it("adminOverview", async () => {
    const rows = await adminOverview(NOW);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(LEAK);
  });

  it("systemHealth", async () => {
    expect(JSON.stringify(await systemHealth(NOW))).not.toMatch(LEAK);
  });

  it("costRows", async () => {
    const rows = await costRows(NOW);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(LEAK);
  });

  it("listInvites", async () => {
    expect(JSON.stringify(await listInvites())).not.toMatch(LEAK);
  });

  it("lastTestPaymentsResult", async () => {
    expect(JSON.stringify(await lastTestPaymentsResult())).not.toMatch(LEAK);
  });

  it("/admin/growth's readers (listGrowthAdmin, growthAccountChoices, growthStateForEmails, countGrowthClients)", async () => {
    // A Growth client on the same SECRET-filled workspace, with Davi's own update and numbers.
    const before = await growthAccountChoices();
    expect(before).toHaveLength(1);
    expect(JSON.stringify(before)).not.toMatch(LEAK);
    expect(
      await startGrowth({
        workspaceId: before[0]!.workspaceId,
        services: ["google_ads"],
        startedOn: "2026-09-01",
        timeZone: "America/New_York",
      }),
    ).toBe("started");
    const list = await listGrowthAdmin();
    expect(list.clients).toHaveLength(1);
    const clientId = list.clients[0]!.id;
    await postGrowthUpdate(clientId, { title: "Ads live", body: "New ads went live." }, NOW);
    await saveGrowthMonth(
      clientId,
      "2026-09",
      {
        newLeads: 4,
        calls: null,
        jobsWon: null,
        moneyWonCents: null,
        reviewsGained: null,
        adSpendCents: null,
      },
      "Good month.",
      NOW,
    );
    expect(await countGrowthClients()).toBe(1);
    expect(JSON.stringify(await listGrowthAdmin())).not.toMatch(LEAK);
    expect(JSON.stringify([...(await growthStateForEmails(["owner@shop.com"]))])).not.toMatch(LEAK);
  });
});

/** The admin code read as text: src/server/admin.ts, admin-costs.ts and every admin screen. */
function adminFiles(): string[] {
  const out = [
    "src/server/admin.ts",
    "src/server/admin-costs.ts",
    "src/server/growth-client-rules.ts",
  ];
  const walkDir = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walkDir(path);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  };
  walkDir("src/app/(app)/admin");
  return out;
}

/** Content columns as properties (`.subject`), and as raw SQL column names inside sql`…`. */
const CONTENT_PROPS = new Set([
  "subject",
  "bodyText",
  "body",
  "snippet",
  "summary",
  "fromAddress",
  "fromName",
  "toAddress",
  "originalBody",
  "extracted",
]);
const CONTENT_SQL =
  /\b(subject|body_text|body|snippet|summary|from_address|from_name|to_address|original_body|extracted|reason)\b/;
const INBOX_TABLES = /^(threads|messages|drafts)$/;

function contentReads(file: string, text: string): string[] {
  const sf = parseText(file, text);
  const hits: string[] = [];
  walk(sf, (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      const owner = n.expression.getText();
      if (CONTENT_PROPS.has(name)) hits.push(`${owner}.${name}`);
      // A draft's reason quotes what the customer wants.
      if (name === "reason" && /draft/i.test(owner)) hits.push(`${owner}.reason`);
    }
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === "sql") {
      const m = n.template.getText().match(CONTENT_SQL);
      if (m) hits.push(`sql\`…${m[0]}…\``);
    }
    // select() with no columns from an inbox table would return every column.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "from" &&
      n.arguments[0] &&
      INBOX_TABLES.test(n.arguments[0].getText())
    ) {
      const inner = n.expression.expression;
      if (
        ts.isCallExpression(inner) &&
        ts.isPropertyAccessExpression(inner.expression) &&
        inner.expression.name.text === "select" &&
        inner.arguments.length === 0
      ) {
        hits.push(`select().from(${n.arguments[0].getText()})`);
      }
    }
  });
  return hits;
}

describe("admin code never reads content columns (static)", () => {
  it("finds the admin files", () => {
    const files = adminFiles();
    expect(files).toContain("src/app/(app)/admin/page.tsx");
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("no .subject, .bodyText, .body, .snippet, .summary, addresses, names, drafts' reason or extracted", () => {
    const found = adminFiles().flatMap((f) =>
      contentReads(f, readFileSync(f, "utf8")).map((hit) => `${f}: ${hit}`),
    );
    expect(found).toEqual([]);
  });

  it("/admin/growth's readers in growth-clients.ts read no content columns", () => {
    // Only the functions /admin and /admin/growth call: the client's own dashboard and Davi's
    // emails (his own update words) live in the same file and aren't admin readers.
    const text = readFileSync("src/server/growth-clients.ts", "utf8");
    const readers = [
      "countGrowthClients",
      "listGrowthAdmin",
      "growthAccountChoices",
      "growthStateForEmails",
    ];
    for (const name of readers) {
      const start = text.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const body = text.slice(start, text.indexOf("\n}\n", start) + 2);
      expect(contentReads(`${name}.ts`, body), name).toEqual([]);
      // And none of them touches an inbox table at all.
      expect(body, name).not.toMatch(/\b(threads|messages|drafts|mailboxes)\b/);
    }
  });

  it("self-test: the guard catches each shape", () => {
    const hits = contentReads(
      "fixture.ts",
      [
        "db().select({ s: threads.subject, b: messages.bodyText, a: drafts.toAddress }).from(threads);",
        "const why = draft.reason; const r = row.extracted;",
        "sql`select from_address from messages`;",
        "db().select().from(drafts);",
        "const ok = params.reason;",
      ].join("\n"),
    );
    expect(hits).toEqual([
      "threads.subject",
      "messages.bodyText",
      "drafts.toAddress",
      "draft.reason",
      "row.extracted",
      "sql`…from_address…`",
      "select().from(drafts)",
    ]);
  });
});
