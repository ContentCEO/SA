import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { drafts, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { monthMoney } from "@/server/activity";
import {
  dollarsToCents,
  groupByDay,
  moneyIsEmpty,
  tally,
  tallyText,
} from "@/server/activity-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

/** Outside review K1: Activity leads with money; the feed is grouped by the owner's day. */
const TZ = "America/New_York";
const NOW = new Date("2026-10-15T16:00:00Z"); // Oct 15, noon in New York
const DAY = 86_400_000;

describe("activity rules", () => {
  it("adds up what has an amount and counts what doesn't", () => {
    expect(tally([420_000, null, 50_000, 0])).toEqual({
      count: 4,
      cents: 470_000,
      withoutAmount: 2,
    });
    expect(tally([])).toEqual({ count: 0, cents: 0, withoutAmount: 0 });
    expect(dollarsToCents(1850)).toBe(185_000);
    expect(dollarsToCents(12.5)).toBe(1250);
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(-3)).toBeNull();
  });

  it("says it plainly", () => {
    expect(tallyText(tally([]))).toBe("None yet");
    expect(tallyText(tally([420_000]))).toBe("1 · $4,200");
    expect(tallyText(tally([420_000, null]))).toBe(
      "2 · $4,200 (1 more without an amount we could see)",
    );
    expect(tallyText(tally([null, null]))).toBe("2 · no amounts we could see");
    expect(moneyIsEmpty({ won: tally([]), paidAfterNudge: tally([]) })).toBe(true);
    expect(moneyIsEmpty({ won: tally([null]), paidAfterNudge: tally([]) })).toBe(false);
  });

  it("groups by the owner's calendar day, keeping the order", () => {
    const at = (iso: string) => ({ at: new Date(iso) });
    const groups = groupByDay(
      [
        at("2026-10-15T15:00:00Z"), // 11am today
        at("2026-10-15T04:30:00Z"), // 12:30am today in New York
        at("2026-10-15T03:30:00Z"), // 11:30pm yesterday in New York (already the 15th in UTC)
        at("2026-10-13T15:00:00Z"),
        at("2025-12-31T15:00:00Z"),
      ],
      NOW,
      TZ,
    );
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Tuesday, Oct 13", 1],
      ["Wednesday, Dec 31, 2025", 1],
    ]);
  });

  it("handles the clock change (Nov 1, 2026 in New York)", () => {
    const now = new Date("2026-11-02T12:00:00Z"); // 7am Nov 2, EST
    const groups = groupByDay(
      [{ at: new Date("2026-11-02T04:30:00Z") }, { at: new Date("2026-11-01T04:30:00Z") }],
      now,
      TZ,
    );
    // 11:30pm Nov 1 EST, then 12:30am Nov 1 EDT.
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([["Yesterday", 2]]);
  });
});

describe("monthMoney", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let n = 0;

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
  }, 30_000);

  async function thread(over: Partial<typeof threads.$inferInsert>, box = mailboxId) {
    const [t] = await database
      .insert(threads)
      .values({ mailboxId: box, gmailThreadId: `t${++n}`, inInbox: true, ...over })
      .returning();
    return t!;
  }
  async function nudge(threadId: string, decidedAt: Date, status: "sent" | "pending" = "sent") {
    await database.insert(drafts).values({
      threadId,
      mailboxId,
      kind: "followup",
      toAddress: "c@x.com",
      subject: "Re: Invoice",
      reason: "Nudge",
      status,
      decidedAt,
    });
  }
  const invoice = (amount: number | null) => ({
    invoice: { invoice_number: "41", amount, due_date: null, status: "paid" },
  });

  it("counts quotes won this month in the owner's month, owner or guess", async () => {
    await thread({
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: new Date(NOW.getTime() - DAY),
      quoteAmountCents: 420_000,
    });
    await thread({
      quoteOutcome: "won",
      quoteOutcomeSource: "auto",
      quoteOutcomeAt: new Date(NOW.getTime() - 2 * DAY),
    });
    await thread({
      quoteOutcome: "lost",
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: NOW,
      quoteAmountCents: 99_900,
    });
    // Oct 1, 1am UTC = Sep 30 in New York: last month.
    await thread({
      quoteOutcome: "won",
      quoteOutcomeSource: "owner",
      quoteOutcomeAt: new Date("2026-10-01T01:00:00Z"),
      quoteAmountCents: 100_000,
    });
    // Another owner's win never counts.
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    const otherBox = await saveConnectedMailbox(other, {
      email: "other@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    await thread(
      {
        quoteOutcome: "won",
        quoteOutcomeSource: "owner",
        quoteOutcomeAt: NOW,
        quoteAmountCents: 5_000,
      },
      otherBox.id,
    );

    const m = await monthMoney(workspaceId, NOW, TZ);
    expect(m.won).toEqual({ count: 2, cents: 420_000, withoutAmount: 1 });
    expect(m.paidAfterNudge.count).toBe(0);
  });

  it("counts invoices paid this month only after a sent nudge, never 'not owed'", async () => {
    const paidAt = new Date(NOW.getTime() - DAY);
    const a = await thread({
      extracted: invoice(1850),
      invoicePaidAt: paidAt,
      invoicePaidSource: "owner",
    });
    await nudge(a.id, new Date(paidAt.getTime() - 3 * DAY));
    const b = await thread({
      extracted: invoice(null),
      invoicePaidAt: paidAt,
      invoicePaidSource: "auto",
    });
    await nudge(b.id, new Date(paidAt.getTime() - DAY));
    // Paid before the nudge went: not "after a follow-up".
    const c = await thread({
      extracted: invoice(500),
      invoicePaidAt: paidAt,
      invoicePaidSource: "owner",
    });
    await nudge(c.id, new Date(paidAt.getTime() + 1000));
    // A nudge that was never sent doesn't count.
    const d = await thread({
      extracted: invoice(700),
      invoicePaidAt: paidAt,
      invoicePaidSource: "owner",
    });
    await nudge(d.id, new Date(paidAt.getTime() - DAY), "pending");
    // "Not owed to me" is not money collected.
    const e = await thread({
      extracted: invoice(900),
      invoicePaidAt: paidAt,
      invoicePaidSource: "not_owed",
    });
    await nudge(e.id, new Date(paidAt.getTime() - DAY));
    // Paid last month (in New York).
    const f = await thread({
      extracted: invoice(300),
      invoicePaidAt: new Date("2026-10-01T03:00:00Z"),
      invoicePaidSource: "owner",
    });
    await nudge(f.id, new Date("2026-09-25T12:00:00Z"));

    const m = await monthMoney(workspaceId, NOW, TZ);
    expect(m.paidAfterNudge).toEqual({ count: 2, cents: 185_000, withoutAmount: 1 });
  });
});
