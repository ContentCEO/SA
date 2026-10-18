import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { businessProfiles, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { moneySoFar } from "@/server/activity";
import { MONEY_SO_FAR_NOTE, moneySoFarLines, tally } from "@/server/activity-rules";
import { buildDigest, digestCounts } from "@/server/digest";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

const links = {
  queueUrl: "https://app/queue",
  quotesUrl: "https://app/quotes",
  settingsUrl: "https://app/settings",
  threadUrl: (id: string) => `https://app/queue#t-${id}`,
};
const none = { count: 0, cents: 0, withoutAmount: 0 };

describe("money so far: the words (pure)", () => {
  it("adds up, says what's counted, and leaves out zero parts", () => {
    expect(
      moneySoFarLines({
        won: tally([420_000, null]),
        paid: tally([120_000, 60_000]),
        owed: { count: 2, cents: 305_000 },
      }),
    ).toEqual([
      "This month so far: $4,200 in quotes you won (+1 with no amount we could see) · $1,800 in invoices paid.",
      "Still owed to you: $3,050 on Money owed.",
    ]);
    expect(
      moneySoFarLines({ won: tally([99_950]), paid: none, owed: { count: 0, cents: 0 } }),
    ).toEqual(["This month so far: $999.50 in quotes you won."]);
    expect(moneySoFarLines({ won: none, paid: none, owed: { count: 1, cents: 50_000 } })).toEqual([
      "Still owed to you: $500 on Money owed.",
    ]);
    expect(
      moneySoFarLines({
        won: tally([null, null]),
        paid: tally([null]),
        owed: { count: 1, cents: 0 },
      }),
    ).toEqual([
      "This month so far: 2 quotes won (no amounts we could see) · 1 invoice paid (no amounts we could see).",
      "Still owed to you: 1 invoice on Money owed (no amounts we could see).",
    ]);
    expect(moneySoFarLines({ won: none, paid: none, owed: { count: 0, cents: 0 } })).toEqual([]);
  });
});

describe("money so far: the numbers", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let n = 0;
  // Sat Oct 31, 11:30pm in New York (EDT) = Nov 1, 03:30 UTC: still October for the owner.
  const NOW = new Date("2026-11-01T03:30:00Z");

  async function thread(
    over: Partial<typeof threads.$inferInsert>,
    from = "SECRET-dana@customer.example",
  ) {
    n += 1;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: `g-${n}`,
        inInbox: true,
        subject: `SECRET-SUBJECT-${n}`,
        summary: "SECRET-SUMMARY",
        lastMessageAt: new Date("2026-10-20T15:00:00Z"),
        ...over,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `g-${n}-m`,
      direction: "in",
      fromName: "SECRET Customer",
      fromAddress: from,
      bodyText: "SECRET-BODY",
      sentAt: new Date("2026-10-20T15:00:00Z"),
    });
    return t!;
  }
  const won = (at: string, cents: number | null, source: "owner" | "auto" = "owner") =>
    thread({
      category: "quote_request",
      quoteOutcome: "won",
      quoteOutcomeSource: source,
      quoteOutcomeAt: new Date(at),
      quoteAmountCents: cents,
    });
  const invoice = (
    amount: number | null,
    over: Partial<typeof threads.$inferInsert> = {},
    from?: string,
  ) =>
    thread(
      {
        category: "invoice_payment",
        extracted: {
          invoice: {
            invoice_number: "SECRET-INV",
            amount,
            due_date: null,
            status: over.invoicePaidAt ? "paid" : "unpaid",
          },
        },
        ...over,
      },
      from,
    );

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    await database.insert(businessProfiles).values({ workspaceId, timeZone: "America/New_York" });
  });

  it("counts won quotes by when they were decided, and invoices from Money owed's own rows", async () => {
    // Won: in October (owner's and our guess), one with no amount; September's doesn't count.
    await won("2026-10-02T15:00:00Z", 420_000);
    await won("2026-10-31T20:00:00Z", 80_000, "auto");
    await won("2026-10-15T15:00:00Z", null);
    await won("2026-09-29T15:00:00Z", 999_900);
    await thread({
      category: "quote_request",
      quoteOutcome: "lost",
      quoteOutcomeAt: new Date("2026-10-10T15:00:00Z"),
      quoteAmountCents: 5_000_00,
    });
    // Paid this month: the owner's mark and our guess.
    await invoice(1200, {
      invoicePaidAt: new Date("2026-10-05T15:00:00Z"),
      invoicePaidSource: "owner",
    });
    await invoice(300, {
      invoicePaidAt: new Date("2026-10-30T15:00:00Z"),
      invoicePaidSource: "auto",
    });
    // Never counted: paid last month, "Not owed to me", a supplier's bill, a receipt sender,
    // and a bill the owner has to pay.
    await invoice(7000, {
      invoicePaidAt: new Date("2026-09-20T15:00:00Z"),
      invoicePaidSource: "owner",
    });
    await invoice(7000, {
      invoicePaidAt: new Date("2026-10-06T15:00:00Z"),
      invoicePaidSource: "not_owed",
    });
    await invoice(7000, {
      category: "supplier_vendor",
      invoicePaidAt: new Date("2026-10-06T15:00:00Z"),
      invoicePaidSource: "owner",
    });
    await invoice(
      7000,
      { invoicePaidAt: new Date("2026-10-06T15:00:00Z"), invoicePaidSource: "auto" },
      "receipts@stripe.com",
    );
    await invoice(7000, {
      extracted: {
        invoice: { invoice_number: "SECRET", amount: 7000, due_date: null, status: "unpaid" },
        bill_direction: "owed_by_business",
      },
    });
    // Still owed now (sent whenever): $500 and $250.
    await invoice(500);
    await invoice(250);
    await invoice(9000, { category: "supplier_vendor" });

    const m = await moneySoFar(workspaceId, NOW);
    expect(m.won).toEqual({ count: 3, cents: 500_000, withoutAmount: 1 });
    expect(m.paid).toEqual({ count: 2, cents: 150_000, withoutAmount: 0 });
    expect(m.owed).toEqual({ count: 2, cents: 75_000 });
  });

  it("the month is the owner's, in their time zone (and reaches past Money's 30-day list)", async () => {
    // 11pm Sep 30 in New York (Oct 1, 03:00 UTC): September for this owner.
    await won("2026-10-01T03:00:00Z", 100_00);
    await invoice(100, {
      invoicePaidAt: new Date("2026-10-01T03:00:00Z"),
      invoicePaidSource: "owner",
    });
    // 1am Oct 1 in New York: October — over 30 days before NOW, still this month.
    await won("2026-10-01T05:00:00Z", 200_00);
    await invoice(200, {
      invoicePaidAt: new Date("2026-10-01T05:00:00Z"),
      invoicePaidSource: "owner",
    });

    const ny = await moneySoFar(workspaceId, NOW);
    expect(ny.won.cents).toBe(200_00);
    expect(ny.paid.cents).toBe(200_00);
    // The same instants for an owner on UTC: it's already November, so nothing yet.
    const utc = await moneySoFar(workspaceId, NOW, "UTC");
    expect(utc.won.count).toBe(0);
    expect(utc.paid.count).toBe(0);
    // In Los Angeles both instants are still September 30 (8pm and 10pm): nothing this month.
    const la = await moneySoFar(workspaceId, NOW, "America/Los_Angeles");
    expect(la.won.count).toBe(0);
    expect(la.paid.count).toBe(0);
  });

  it("GUARDRAIL: the morning email gets totals only, and no section when all is zero", async () => {
    const empty = buildDigest(
      { ...(await digestCounts(workspaceId, NOW, "America/New_York")) },
      links,
      { now: NOW, timeZone: "America/New_York" },
    );
    expect(empty.text).not.toContain("This month so far");
    expect(empty.text).not.toContain("Still owed");
    expect(empty.text).not.toContain(MONEY_SO_FAR_NOTE);

    await won("2026-10-02T15:00:00Z", 420_000);
    await invoice(1200, {
      invoicePaidAt: new Date("2026-10-05T15:00:00Z"),
      invoicePaidSource: "owner",
    });
    await invoice(500);
    const c = await digestCounts(workspaceId, NOW, "America/New_York");
    const d = buildDigest(c, links, { now: NOW, timeZone: "America/New_York" });
    for (const body of [d.text, d.html]) {
      expect(body).toContain(
        "This month so far: $4,200 in quotes you won · $1,200 in invoices paid.",
      );
      expect(body).toContain("Still owed to you: $500 on Money owed.");
    }
    expect(d.text).toContain(MONEY_SO_FAR_NOTE);
    expect(`${d.subject}\n${d.text}\n${d.html}`).not.toMatch(/SECRET|@customer\.example/i);
    // Money alone never makes a quiet morning worth an email.
    expect(d.worthSending).toBe(false);
  });
});
