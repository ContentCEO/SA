import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { businessProfiles, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { buildDigest, digestCounts } from "@/server/digest";
import { listQueue, queueCounts, queueMembership } from "@/server/drafts";
import { markAnsweredByPhone } from "@/server/first-week";
import { leadCardsFor } from "@/server/lead-cards";
import { addServiceTown, closeComplaintCheckin, markComplaintFixed } from "@/server/leads";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { notAnsweredYet } from "@/server/never-answered";
import { createTestDb } from "../support/db";

/**
 * Leads package on the real database code: the emergency lane, Done, complaint check-ins,
 * "Not answered yet", Call / Text numbers, the repeat-customer and towns lines — and the
 * queue's numbers staying the same for the screen, the badge, push and the morning email.
 */
const NOW = new Date("2026-10-16T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
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
      category: "customer_question",
      summary: "A question.",
      classifiedAt: NOW,
      lastMessageAt: hoursAgo(1),
      ...over,
    })
    .returning();
  return t!;
}
async function inbound(threadId: string, over: Partial<typeof messages.$inferInsert> = {}) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `m${++n}`,
    direction: "in",
    fromAddress: "dana@example.com",
    fromName: "Dana Ruiz",
    replyToHeader: {},
    subject: "Help",
    bodyText: "Can you come look? My cell is 978-201-9763.",
    labelIds: ["INBOX"],
    sentAt: hoursAgo(2),
    ...over,
  });
}
async function outbound(threadId: string, over: Partial<typeof messages.$inferInsert> = {}) {
  await database.insert(messages).values({
    threadId,
    mailboxId,
    gmailMessageId: `o${++n}`,
    direction: "out",
    fromAddress: "mike@ruizplumbing.com",
    toAddresses: ["dana@example.com"],
    labelIds: ["SENT"],
    bodyText: "Thanks, Mike\nRuiz Plumbing 978-555-0234",
    sentAt: daysAgo(40),
    ...over,
  });
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
    .set({ lastSyncedAt: hoursAgo(0.1) })
    .where(eq(mailboxes.id, mailboxId));
  await database
    .update(workspaces)
    .set({ businessName: "Ruiz Plumbing" })
    .where(eq(workspaces.id, workspaceId));
});

describe("emergency lane (B5)", () => {
  it("emergencies sort first; counts agree everywhere", async () => {
    const plain = await thread({ needsOwner: true, lastMessageAt: hoursAgo(0.5) });
    await inbound(plain.id);
    const sos = await thread({
      needsOwner: true,
      priority: "high",
      lastMessageAt: hoursAgo(3),
      extracted: { urgency: "emergency" },
    });
    await inbound(sos.id);
    const sneaky = await thread({
      needsOwner: true,
      lastMessageAt: hoursAgo(0.2),
      extracted: { urgency: "emergency", injection: true },
    });
    await inbound(sneaky.id);
    const m = await queueMembership(workspaceId, NOW);
    expect(m.needsYou.map((x) => [x.threadId, x.lane])).toEqual([
      [sos.id, true],
      [sneaky.id, false],
      [plain.id, false],
    ]);
    const counts = await queueCounts(workspaceId, NOW);
    const digest = await digestCounts(workspaceId, NOW, "America/New_York");
    const screen = await listQueue(workspaceId, NOW);
    expect(counts.needsYou).toBe(3);
    expect(digest.needsYou).toHaveLength(3);
    expect(screen.needsYou).toHaveLength(3);
    expect(screen.needsYou[0]!.lane).toBe(true);
  });
});

describe("Call / Text numbers (B4)", () => {
  it("offers the customer's number, never the owner's, in a fixed number of queries", async () => {
    const cards = [];
    for (let i = 0; i < 3; i++) {
      const t = await thread({ needsOwner: true, category: "quote_request" });
      await inbound(t.id, {
        bodyText: i === 0 ? "Call me 978-201-9763" : "Reach me via Mike at 978-555-0234",
      });
      cards.push(t);
    }
    await outbound(cards[1]!.id);
    const q = await listQueue(workspaceId, NOW);
    const lc = await leadCardsFor(
      workspaceId,
      q.needsYou.map((i) => ({ ...i, needsYou: true })),
      { now: NOW, timeZone: "America/New_York", businessName: "Ruiz Plumbing" },
    );
    expect(lc.get(cards[0]!.id)?.phone).toBe("+19782019763");
    expect(lc.get(cards[0]!.id)?.textBody).toBe(
      "Hi Dana, this is Ruiz Plumbing. I got your message.",
    );
    expect(lc.get(cards[1]!.id)?.phone).toBeNull();
    expect(lc.get(cards[2]!.id)?.phone).toBeNull();
  });

  it("a draft card gets no buttons; a lead site needs a labelled number", async () => {
    const site = await thread({ needsOwner: true, category: "quote_request", leadChannel: "angi" });
    await inbound(site.id, {
      fromAddress: "no-reply@angi.com",
      fromName: "Angi",
      bodyText: "Questions? Call Angi 978-201-1111\nName: Sam Lee\nPhone: 978-201-2222",
    });
    const plain = await thread({ category: "quote_request" });
    await inbound(plain.id);
    const only = await leadCardsFor(
      workspaceId,
      [
        {
          threadId: site.id,
          category: "quote_request",
          leadChannel: "angi",
          extracted: null,
          customerName: "Angi",
          customerAddress: "no-reply@angi.com",
          needsYou: true,
        },
        {
          threadId: plain.id,
          category: "quote_request",
          leadChannel: null,
          extracted: null,
          customerName: "Dana Ruiz",
          customerAddress: "dana@example.com",
          needsYou: false,
        },
      ],
      { now: NOW, timeZone: "America/New_York", businessName: null },
    );
    // A draft card: the reply is the answer, no buttons.
    expect(only.get(plain.id)?.phone).toBeNull();
    const card = only.get(site.id)!;
    expect(card.phone).toBe("+19782012222");
    expect(card.firstName).toBe("Sam");
    expect(card.channel).toEqual({ kind: "site", name: "Angi", openUrl: "https://www.angi.com/" });
  });
});

describe("Done and complaint check-ins (G5)", () => {
  it("Done takes a card off until the customer writes again", async () => {
    const t = await thread({ needsOwner: true, leadChannel: "google_voice" });
    await inbound(t.id, { fromAddress: "voice-noreply@google.com" });
    expect((await queueCounts(workspaceId, NOW)).needsYou).toBe(1);
    await markAnsweredByPhone(workspaceId, t.id, { now: () => NOW });
    expect((await queueCounts(workspaceId, NOW)).needsYou).toBe(0);
    await inbound(t.id, { fromAddress: "voice-noreply@google.com", sentAt: hoursAgo(-0.1) });
    expect((await queueCounts(workspaceId, hoursAgo(-0.2))).needsYou).toBe(1);
  });

  it("Mark fixed, check-in at two days, All good; refused with a draft or a legal threat", async () => {
    const t = await thread({ needsOwner: true, category: "complaint", priority: "high" });
    await inbound(t.id, { sentAt: daysAgo(4) });
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t.id,
        mailboxId,
        kind: "reply",
        gmailDraftId: "gd",
        toAddress: "dana@example.com",
        subject: "Re: Help",
        body: "Sorry",
        originalBody: "Sorry",
        reason: "r",
        flags: [],
        confidence: 80,
        promptVersion: "draft.v6",
      })
      .returning();
    expect(await markComplaintFixed(workspaceId, t.id, daysAgo(3))).toBe("has_draft");
    await database.delete(drafts).where(eq(drafts.id, d!.id));
    expect(await markComplaintFixed(workspaceId, t.id, daysAgo(3))).toBe("fixed");
    // Off Needs you right away; back as a check-in two days later.
    expect((await queueMembership(workspaceId, daysAgo(2.5))).needsYou).toHaveLength(0);
    const m = await queueMembership(workspaceId, NOW);
    expect(m.needsYou.map((x) => [x.threadId, x.checkIn])).toEqual([[t.id, true]]);
    expect((await listQueue(workspaceId, NOW)).needsYou[0]!.checkIn).toBe(true);
    expect((await digestCounts(workspaceId, NOW, "America/New_York")).needsYou).toHaveLength(1);
    expect(await closeComplaintCheckin(workspaceId, t.id, NOW)).toBe("closed");
    expect((await queueMembership(workspaceId, NOW)).needsYou).toHaveLength(0);

    const legal = await thread({
      needsOwner: true,
      category: "complaint",
      extracted: { owner_rule_hits: ["complaint", "legal"] },
    });
    expect(await markComplaintFixed(workspaceId, legal.id, NOW)).toBe("not_complaint");
  });

  it("a customer email after the fix brings the complaint back instead of the check-in", async () => {
    const t = await thread({ needsOwner: true, category: "complaint" });
    await inbound(t.id, { sentAt: daysAgo(5) });
    await markComplaintFixed(workspaceId, t.id, daysAgo(4));
    await inbound(t.id, { sentAt: daysAgo(1), bodyText: "It's leaking again" });
    const m = await queueMembership(workspaceId, NOW);
    expect(m.needsYou.map((x) => [x.threadId, x.checkIn])).toEqual([[t.id, false]]);
  });

  it("read-only accounts can't mark anything", async () => {
    const t = await thread({ needsOwner: true, category: "complaint" });
    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspaceId));
    await expect(markComplaintFixed(workspaceId, t.id, NOW)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(addServiceTown(workspaceId, t.id, NOW)).rejects.toBeInstanceOf(ReadOnlyError);
  });
});

describe("not answered yet (B6)", () => {
  it("one row per customer, over a day, not on the queue, not a lead site; digest counts it", async () => {
    const old = await thread({ category: "customer_question", lastMessageAt: daysAgo(3) });
    await inbound(old.id, { sentAt: daysAgo(3) });
    const same = await thread({ category: "scheduling", lastMessageAt: daysAgo(2) });
    await inbound(same.id, { sentAt: daysAgo(2) });
    const fresh = await thread({ category: "customer_question" });
    await inbound(fresh.id, { fromAddress: "sam@example.com", sentAt: hoursAgo(5) });
    const answered = await thread({ category: "customer_question" });
    await inbound(answered.id, { fromAddress: "lee@example.com", sentAt: daysAgo(2) });
    await outbound(answered.id, { toAddresses: ["lee@example.com"], sentAt: daysAgo(1.5) });
    const site = await thread({ category: "quote_request", leadChannel: "thumbtack" });
    await inbound(site.id, { fromAddress: "pro@thumbtack.com", sentAt: daysAgo(2) });
    const robot = await thread({ category: "quote_request" });
    await inbound(robot.id, { fromAddress: "no-reply@forms.example", sentAt: daysAgo(2) });
    const card = await thread({ category: "customer_question", needsOwner: true });
    await inbound(card.id, { fromAddress: "pat@example.com", sentAt: daysAgo(2) });

    const onQueue = new Set(
      [...(await queueMembership(workspaceId, NOW)).needsYou].map((m) => m.threadId),
    );
    const rows = await notAnsweredYet(workspaceId, NOW, onQueue);
    expect(rows.map((r) => r.threadId)).toEqual([old.id]);

    const c = await digestCounts(workspaceId, NOW, "America/New_York");
    expect(c.notAnswered).toBe(1);
    const email = buildDigest(
      c,
      {
        queueUrl: "https://app.test/queue",
        quotesUrl: "https://app.test/quotes",
        settingsUrl: "https://app.test/settings",
        threadUrl: (id) => `https://app.test/queue#t-${id}`,
      },
      { now: NOW, timeZone: "America/New_York" },
    );
    expect(email.text).toContain(
      "• 1 customer has waited more than a day for an answer: https://app.test/queue",
    );
    expect(email.text).not.toContain("dana");

    // Done answers it.
    await markAnsweredByPhone(workspaceId, old.id, { now: () => NOW });
    expect((await notAnsweredYet(workspaceId, NOW, onQueue)).map((r) => r.threadId)).toEqual([
      same.id,
    ]);
  });
});

describe("repeat customers and towns (B14, B9)", () => {
  it("the repeat line says what happened, and Add town clears only its own reason", async () => {
    const won = await thread({
      category: "quote_request",
      quoteOutcome: "won",
      quoteOutcomeSource: "auto",
      quoteOutcomeAt: new Date("2026-03-12T15:00:00Z"),
      extracted: { service_requested: "Water heater replacement" },
    });
    await inbound(won.id, { sentAt: new Date("2026-03-01T15:00:00Z") });
    const asked = await thread({
      category: "quote_request",
      extracted: { service_requested: "Deck repair" },
    });
    await inbound(asked.id, { fromAddress: "sam@example.com", sentAt: daysAgo(100) });
    // Only an unsent Gmail draft "answered" it: still "asked".
    await outbound(asked.id, {
      toAddresses: ["sam@example.com"],
      labelIds: ["DRAFT"],
      sentAt: daysAgo(99),
    });

    await database.insert(businessProfiles).values({ workspaceId, serviceTowns: ["Lowell, MA"] });
    const now1 = await thread({
      category: "quote_request",
      needsOwner: true,
      needsOwnerReason: "Outside the towns you work in.",
      extracted: { address: "3 Pine Rd, Nashua, NH", owner_rule_hits: ["outside_area"] },
    });
    await inbound(now1.id);
    const now2 = await thread({ category: "quote_request", needsOwner: true });
    await inbound(now2.id, { fromAddress: "sam@example.com" });
    const first = await thread({
      category: "quote_request",
      needsOwner: true,
      extracted: {
        address: "9 Oak St, Dracut, MA",
        owner_rule_hits: ["big_new_job", "outside_area"],
      },
    });
    await inbound(first.id, { fromAddress: "new@example.com" });

    const q = await listQueue(workspaceId, NOW);
    const lc = await leadCardsFor(
      workspaceId,
      q.needsYou.map((i) => ({ ...i, needsYou: true })),
      { now: NOW, timeZone: "America/New_York", businessName: null },
    );
    expect(lc.get(now1.id)?.repeat).toBe(
      "Repeat customer: they said yes to your quote for their water heater replacement in March.",
    );
    expect(lc.get(now2.id)?.repeat).toBe("Repeat customer: they asked about deck repair in July.");
    expect(lc.get(first.id)?.repeat).toBeNull();
    expect(lc.get(now1.id)?.outsideTown).toBe("Nashua, NH");
    expect(lc.get(now1.id)?.townClears).toBe(true);
    expect(lc.get(first.id)?.townClears).toBe(false);

    expect(await addServiceTown(workspaceId, now1.id, NOW)).toBe("added");
    expect(await addServiceTown(workspaceId, first.id, NOW)).toBe("added");
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p!.serviceTowns).toEqual(["Lowell, MA", "Nashua, NH", "Dracut, MA"]);
    const rows = await database.select().from(threads);
    expect(rows.find((r) => r.id === now1.id)!.needsOwner).toBe(false);
    // A big job from a first-time sender still needs the owner.
    expect(rows.find((r) => r.id === first.id)!.needsOwner).toBe(true);
  });
});
