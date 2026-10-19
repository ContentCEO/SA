import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { businessProfiles, mailboxes, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import { listCustomers } from "@/server/customers";
import { leadsAtRisk } from "@/server/leads-at-risk";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { monthlyStats } from "@/server/monthly-summary";
import { threadOffers } from "@/server/offers";
import type { ReplyToHeader } from "@/server/reply-address-rules";
import { weeklyScorecard } from "@/server/scorecard";
import { lastOutSql } from "@/server/thread-sql";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";

/**
 * Review "Must fix" (B1): the same root cause made form leads look like machines everywhere
 * the code means "the customer". Each screen and count now reads the reply address.
 */
const NY = "America/New_York";
// Tuesday 13 Oct 2026, 13:01 in New York (UTC-4).
const NOW = new Date("2026-10-13T17:01:00Z");
const hrs = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const WIX = "no-reply@crm.wix.com";
const SQUARESPACE = "form-submission@squarespace.info";
const REVIEW_URL = "https://g.page/r/ruiz/review";

let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;

async function thread(over: Partial<typeof threads.$inferInsert> = {}) {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `g${++n}`,
      inInbox: true,
      category: "quote_request",
      classifiedAt: hrs(4.5),
      lastMessageAt: hrs(4.5),
      ...over,
    })
    .returning();
  return t!;
}

async function email(
  threadId: string,
  over: Partial<typeof messages.$inferInsert> & {
    replyToHeader?: ReplyToHeader | null;
  } = {},
) {
  const [m] = await database
    .insert(messages)
    .values({
      threadId,
      mailboxId,
      gmailMessageId: `m${++n}`,
      direction: "in",
      fromAddress: WIX,
      fromName: "Wix Forms",
      subject: "New form submission",
      bodyText: "Name: Dana\nMessage: Can you quote a water heater?",
      sentAt: hrs(4.5),
      ...over,
    })
    .returning();
  return m!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "mike@ruizplumbing.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "mike@ruizplumbing.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  await database
    .update(mailboxes)
    .set({ lastSyncedAt: hrs(0.1), backfillCompletedAt: hrs(48), historyId: "1" })
    .where(eq(mailboxes.id, mailboxId));
  await database
    .insert(businessProfiles)
    .values({ workspaceId, timeZone: NY, reviewUrl: REVIEW_URL });
});

afterEach(() => setModelTransportForTests(undefined));

describe("customers", () => {
  it("two people through one Squarespace form are two customers, named as they gave it", async () => {
    const a = await thread();
    await email(a.id, {
      fromAddress: SQUARESPACE,
      fromName: "Squarespace",
      replyToHeader: { address: "dana@example.net", name: "Dana Ruiz" },
    });
    const b = await thread();
    await email(b.id, {
      fromAddress: SQUARESPACE,
      fromName: "Squarespace",
      replyToHeader: { address: "sam@example.org", name: "Sam Lee" },
    });
    const list = await listCustomers(workspaceId, NOW);
    expect(list.map((c) => [c.address, c.name]).sort()).toEqual([
      ["dana@example.net", "Dana Ruiz"],
      ["sam@example.org", "Sam Lee"],
    ]);
    expect(JSON.stringify(list)).not.toContain("squarespace");
  });
});

describe("leads at risk and the scorecard", () => {
  it("a Wix lead (no-reply robot From) is a person waiting, not a machine", async () => {
    const t = await thread();
    await email(t.id, { replyToHeader: { address: "dana@example.net" } });
    // Same email without a Reply-To: a machine notice, skipped as before.
    const robot = await thread();
    await email(robot.id, { replyToHeader: {} });
    const leads = await leadsAtRisk(workspaceId, NOW, NY);
    expect(leads.map((l) => l.threadId)).toEqual([t.id]);

    const week = await weeklyScorecard(workspaceId, hrs(48), hrs(-1), NOW);
    expect(week.response.unanswered).toBe(1);
  });
});

describe("monthly summary", () => {
  it("form leads from different people aren't one repeat customer; Thumbtack is still Thumbtack", async () => {
    const start = new Date("2026-10-01T04:00:00Z");
    const end = new Date("2026-11-01T04:00:00Z");
    // September: one form lead from Sam.
    const sep = await thread({ quoteRequestedAt: new Date("2026-09-20T15:00:00Z") });
    await email(sep.id, {
      fromAddress: SQUARESPACE,
      replyToHeader: { address: "sam@example.org" },
      sentAt: new Date("2026-09-20T15:00:00Z"),
    });
    // October: a new person through the same form, and a Thumbtack lead.
    const oct = await thread({ quoteRequestedAt: hrs(4.5) });
    await email(oct.id, {
      fromAddress: SQUARESPACE,
      replyToHeader: { address: "dana@example.net" },
    });
    const tt = await thread({ quoteRequestedAt: hrs(3) });
    await email(tt.id, {
      fromAddress: "noreply@thumbtack.com",
      fromName: "Thumbtack",
      replyToHeader: {},
      sentAt: hrs(3),
    });
    const s = await monthlyStats(workspaceId, "plumbing", start, end);
    expect(s.repeatCustomers).toBe(0);
    expect(s.leadSources.map((x) => x.label)).toContain("Thumbtack");

    // Sam comes back in October through the form on a new thread: a repeat customer.
    const back = await thread({ quoteRequestedAt: hrs(2) });
    await email(back.id, {
      fromAddress: SQUARESPACE,
      replyToHeader: { address: "sam@example.org" },
      sentAt: hrs(2),
    });
    expect((await monthlyStats(workspaceId, "plumbing", start, end)).repeatCustomers).toBe(1);
  });
});

describe("review offers", () => {
  /** A finished job; the owner has written to `wroteTo` before. */
  async function finished(replyTo: ReplyToHeader, from = WIX, wroteTo = "dana@example.net") {
    const t = await thread({ category: "customer_question", extracted: { job_done: true } });
    await email(t.id, { fromAddress: from, replyToHeader: replyTo, sentAt: hrs(30) });
    await email(t.id, {
      direction: "out",
      fromAddress: "mike@ruizplumbing.com",
      fromName: null,
      toAddresses: [wroteTo],
      bodyText: "All set, thanks.",
      sentAt: hrs(20),
    });
    await email(t.id, {
      fromAddress: from,
      replyToHeader: replyTo,
      bodyText: "Job's done, works great.",
      sentAt: hrs(10),
    });
    return t.id;
  }

  it("a Wix lead's customer can be asked once the owner wrote to their reply address", async () => {
    const t = await finished({ address: "dana@example.net" });
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(true);
  });

  it("a receipt is still a receipt when its Reply-To is the merchant", async () => {
    const t = await finished({ address: "dana@example.net" }, "receipts@stripe.com");
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
  });

  it("complaint memory blocks by either address", async () => {
    // Dana complained through the website form…
    const c = await thread({ category: "complaint", complainedAt: hrs(100) });
    await email(c.id, { replyToHeader: { address: "dana@example.net" }, sentAt: hrs(100) });
    // …and later writes from her own address about another job.
    const t = await finished({}, "dana@example.net");
    expect((await threadOffers(workspaceId, [t], NOW)).get(t)?.review).toBe(false);
  });
});

describe("classification: first-time sender and VIP", () => {
  it("a new person through a known form is a first-time sender; a spoofed Reply-To with a new From too", async () => {
    // Earlier form lead from Sam: the robot address has written before.
    const earlier = await thread({ classifiedAt: hrs(50) });
    await email(earlier.id, {
      replyToHeader: { address: "sam@example.org" },
      sentAt: hrs(50),
      classifiedAt: hrs(50),
    });
    const t = await thread({ classifiedAt: null, category: null });
    await email(t.id, { replyToHeader: { address: "dana@example.net" }, sentAt: hrs(1) });
    const big = classification({
      signals: { ...classification().signals, large_request: true },
    });
    const { transport, calls } = fakeTransport([big]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls[0]!.user).toContain("First time this sender has emailed the business: yes");
    const [after] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(after!.needsOwner).toBe(true);
    expect(after!.needsOwnerReason).toBe(
      "Big job from someone who hasn't written in the mail we've read so far.",
    );

    // The same person again through the form: not first-time any more.
    const again = await thread({ classifiedAt: null, category: null });
    await email(again.id, { replyToHeader: { address: "dana@example.net" }, sentAt: hrs(0.5) });
    const second = fakeTransport([classification()]);
    setModelTransportForTests(second.transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(second.calls[0]!.user).toContain("First time this sender has emailed the business: no");
  });

  it("VIP by the reply address", async () => {
    await database
      .update(businessProfiles)
      .set({ vipSenders: ["dana@example.net"] })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    const t = await thread({ classifiedAt: null, category: null });
    await email(t.id, { replyToHeader: { address: "dana@example.net" }, sentAt: hrs(1) });
    setModelTransportForTests(fakeTransport([classification()]).transport);
    await classifyPending(mailboxId, { now: NOW });
    const [after] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(after!.needsOwner).toBe(true);
  });
});

describe("side conversations (sideEmailSql) with a form lead", () => {
  it("the owner's Fwd: to the form customer's own address answers them; their later reply isn't a crew reply", async () => {
    const t = await thread({ category: "quote_request" });
    await email(t.id, { replyToHeader: { address: "dana@example.net" }, sentAt: hrs(6) });
    const fwd = await email(t.id, {
      direction: "out",
      fromAddress: "mike@ruizplumbing.com",
      fromName: null,
      replyToHeader: {},
      toAddresses: ["dana@example.net"],
      subject: "Fwd: New form submission",
      sentAt: hrs(5),
    });
    const lastOut = async () =>
      (await database.select({ at: lastOutSql() }).from(threads).where(eq(threads.id, t.id)))[0]!
        .at;
    expect(new Date((await lastOut())!).getTime()).toBe(fwd.sentAt.getTime());
    // Dana answers from her own address: she was on the customer's side all along, so her
    // email leaves her waiting again (a crew reply wouldn't).
    await email(t.id, {
      fromAddress: "dana@example.net",
      fromName: "Dana",
      replyToHeader: {},
      sentAt: hrs(4.2),
    });
    const leads = await leadsAtRisk(workspaceId, NOW, NY);
    expect(leads.map((l) => l.threadId)).toEqual([t.id]);
  });
});
