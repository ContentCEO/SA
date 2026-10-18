import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  customerNotes,
  drafts,
  mailboxes,
  messages,
  ownerSenderRules,
  seasonalNotes,
  threads,
  workspaces,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { awayState, turnAwayOff, turnAwayOn } from "@/server/away";
import { classifyPending } from "@/server/classification";
import { noteFor, notesForThreads, removeNote, saveNote } from "@/server/customer-notes";
import { createDraftForThread } from "@/server/drafts";
import { threadsToFollowUp } from "@/server/followups";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { ReadOnlyError } from "@/server/lifecycle";
import { listRules, removeRule, saveRule } from "@/server/sender-rule-store";
import { resortThread } from "@/server/resort";
import { activeNotes, addSeasonalNote } from "@/server/seasonal-notes";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-14T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
let database: Database;
let mailboxId: string;
let workspaceId: string;

async function thread(gmailThreadId: string, over: Partial<typeof threads.$inferInsert> = {}) {
  const [t] = await database
    .insert(threads)
    .values({ mailboxId, gmailThreadId, inInbox: true, lastMessageAt: NOW, ...over })
    .returning();
  return t!;
}
async function message(
  threadId: string,
  id: string,
  over: Partial<typeof messages.$inferInsert> = {},
) {
  const [m] = await database
    .insert(messages)
    .values({
      threadId,
      mailboxId,
      gmailMessageId: id,
      direction: "in",
      fromAddress: "deals@spammy.com",
      fromName: "Deals",
      replyToHeader: {},
      subject: "Big sale",
      bodyText: `body ${id}`,
      labelIds: ["INBOX"],
      sentAt: daysAgo(1),
      rfc822MessageId: `<${id}@x>`,
      ...over,
    })
    .returning();
  return m!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
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
  // Evaluating keeps jobs on (read-only accounts change nothing).
  await database
    .update(workspaces)
    .set({ status: "evaluating", evaluationEndsAt: new Date(Date.now() + 2 * 86_400_000) })
    .where(eq(workspaces.id, workspaceId));
});

describe("H3 sender rules", () => {
  it("Always junk sorts new email as junk with no model call, and logs no address", async () => {
    const t = await thread("t1");
    const m = await message(t.id, "m1");
    expect(
      await saveRule(workspaceId, { messageId: m.id, action: "junk", scope: "address" }),
    ).toEqual({ status: "saved", action: "junk", scope: "address" });
    const t2 = await thread("t2");
    await message(t2.id, "m2", { subject: "Another sale" });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(0);
    const [row] = await database.select().from(threads).where(eq(threads.id, t2.id));
    expect(row).toMatchObject({ category: "noise", needsOwner: false });
    expect((row!.extracted as { sender_rule?: string }).sender_rule).toBe("junk");
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "sender_rule_added"));
    expect(JSON.stringify(logs.map((l) => l.detail))).not.toContain("@");
  });

  it("junk never hides a complaint-sounding email, a VIP or a spoofed Reply-To", async () => {
    const t = await thread("t1");
    const m = await message(t.id, "m1");
    await saveRule(workspaceId, { messageId: m.id, action: "junk", scope: "address" });
    const a = await thread("ta");
    await message(a.id, "ma", { bodyText: "I'm calling my lawyer about the damage." });
    // A stranger naming the ruled address in Reply-To can't borrow the rule.
    const b = await thread("tb");
    await message(b.id, "mb", {
      fromAddress: "someone@else.com",
      replyToHeader: { address: "deals@spammy.com" },
    });
    // A header never read: the rule never applies.
    const c = await thread("tc");
    await message(c.id, "mc", { replyToHeader: null });
    const { transport, calls } = fakeTransport([
      classification({ category: "complaint" }),
      classification(),
      classification(),
    ]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(3);
  });

  it("a VIP beats a junk rule; a company Always needs me flags with its own reason", async () => {
    const t = await thread("t1");
    const m = await message(t.id, "m1", { fromAddress: "pm@hillpm.com" });
    expect(
      await saveRule(workspaceId, { messageId: m.id, action: "needs_me", scope: "domain" }),
    ).toMatchObject({ status: "saved" });
    // Address-scoped "Always needs me" is the VIP list, not a rule row.
    expect(
      await saveRule(workspaceId, { messageId: m.id, action: "needs_me", scope: "address" }),
    ).toEqual({ status: "vip" });
    const [p] = await database.select().from(businessProfiles);
    expect(p!.vipSenders).toContain("pm@hillpm.com");
    await database.update(businessProfiles).set({ vipSenders: [] });
    const t2 = await thread("t2");
    await message(t2.id, "m2", { fromAddress: "office@north.hillpm.com" });
    setModelTransportForTests(
      fakeTransport([
        classification({ category: "scheduling" }),
        classification({ category: "scheduling" }),
      ]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads).where(eq(threads.id, t2.id));
    expect(row).toMatchObject({
      needsOwner: true,
      needsOwnerReason: "You asked to see every email from this sender.",
    });
  });

  it("refuses junk for someone the owner wrote to, webmail companies, unchecked and lead-site senders", async () => {
    const t = await thread("t1");
    const m = await message(t.id, "m1", { fromAddress: "dana@gmail.com" });
    await message(t.id, "o1", {
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@gmail.com"],
      sentAt: daysAgo(2),
    });
    expect(
      await saveRule(workspaceId, { messageId: m.id, action: "junk", scope: "address" }),
    ).toEqual({ status: "refused", why: "known_customer" });
    expect(
      await saveRule(workspaceId, { messageId: m.id, action: "no_draft", scope: "domain" }),
    ).toEqual({ status: "refused", why: "webmail_company" });
    const u = await message(t.id, "u1", { fromAddress: "x@y.com", replyToHeader: null });
    expect(
      await saveRule(workspaceId, { messageId: u.id, action: "junk", scope: "address" }),
    ).toEqual({ status: "refused", why: "unchecked" });
    const tt = await message(t.id, "tt1", { fromAddress: "leads@thumbtack.com" });
    expect(
      await saveRule(workspaceId, { messageId: tt.id, action: "no_draft", scope: "address" }),
    ).toEqual({ status: "refused", why: "platform" });
    const quote = await thread("tq", { category: "quote_request" });
    const q = await message(quote.id, "q1", { fromAddress: "new@lead.com" });
    expect(
      await saveRule(workspaceId, { messageId: q.id, action: "junk", scope: "address" }),
    ).toEqual({ status: "refused", why: "known_customer" });
  });

  it("the database refuses an address-scoped needs_me row", async () => {
    await expect(
      database.insert(ownerSenderRules).values({
        workspaceId,
        pattern: "a@b.com",
        scope: "address",
        action: "needs_me",
      }),
    ).rejects.toThrow();
  });

  it("Never draft stops jobs (made after sorting too), never the owner's tap", async () => {
    const t = await thread("t1", { category: "scheduling", classifiedAt: NOW });
    const m = await message(t.id, "m1", { fromAddress: "pat@pat.com" });
    expect(
      await saveRule(workspaceId, { messageId: m.id, action: "no_draft", scope: "address" }),
    ).toMatchObject({ status: "saved" });
    const writer = new FakeWriter();
    expect(await createDraftForThread(t.id, { trigger: "auto", writerFor: () => writer })).toEqual({
      status: "skipped",
      reason: "sender_rule",
    });
    setModelTransportForTests(
      fakeTransport([
        { body: "Hi Pat,\n\nThanks.", reason: "x", flags: [], confidence: 0.9, used_facts: [] },
      ]).transport,
    );
    expect(
      (await createDraftForThread(t.id, { trigger: "owner", workspaceId, writerFor: () => writer }))
        .status,
    ).toBe("created");
    const [rule] = await listRules(workspaceId);
    expect(await removeRule(workspaceId, rule!.id)).toBe(true);
    expect(await listRules(workspaceId)).toHaveLength(0);
  });
});

describe("H4 re-sort", () => {
  it("the owner's kind survives the next email; the model's kind is kept apart", async () => {
    const t = await thread("t1", { category: "quote_request" });
    await message(t.id, "m1", { fromAddress: "dana@x.com" });
    expect(await resortThread(workspaceId, t.id, "supplier_vendor")).toBe("moved");
    await message(t.id, "m2", { fromAddress: "dana@x.com", sentAt: daysAgo(0.5) });
    setModelTransportForTests(
      fakeTransport([classification({ category: "quote_request" })]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(row!.category).toBe("supplier_vendor");
    expect(row!.categoryManual).toBe("supplier_vendor");
    expect(row!.quoteRequestedAt).toBeNull();
    expect((row!.extracted as { model_category?: string }).model_category).toBe("quote_request");
  });

  it("moving what the sorter called junk never feeds a job's draft", async () => {
    const t = await thread("t1", { category: "noise", classifiedAt: NOW });
    await message(t.id, "m1", { fromAddress: "dana@x.com" });
    await resortThread(workspaceId, t.id, "customer_question");
    const writer = new FakeWriter();
    expect(await createDraftForThread(t.id, { trigger: "auto", writerFor: () => writer })).toEqual({
      status: "skipped",
      reason: "owner_moved",
    });
  });

  it("to complaint flags it and sets the sticky mark; to quote dates the request; scoped; read-only refused", async () => {
    const t = await thread("t1", { category: "scheduling" });
    await message(t.id, "m1", { fromAddress: "dana@x.com", sentAt: daysAgo(3) });
    await resortThread(workspaceId, t.id, "quote_request");
    let [row] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(row!.quoteRequestedAt?.toISOString()).toBe(daysAgo(3).toISOString());
    await resortThread(workspaceId, t.id, "complaint");
    [row] = await database.select().from(threads).where(eq(threads.id, t.id));
    expect(row).toMatchObject({ needsOwner: true, needsOwnerManual: true, quoteRequestedAt: null });
    expect(row!.complainedAt).not.toBeNull();
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await resortThread(other.workspace.id, t.id, "noise")).toBe("not_found");
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await expect(resortThread(workspaceId, t.id, "noise")).rejects.toBeInstanceOf(ReadOnlyError);
  });

  it("to junk throws away a waiting reply, but not one set to send", async () => {
    const t = await thread("t1", { category: "scheduling" });
    const m = await message(t.id, "m1", { fromAddress: "dana@x.com" });
    const writer = new FakeWriter();
    const { draftId } = await writer.createDraft({ threadId: "t1", raw: "" });
    const [d] = await database
      .insert(drafts)
      .values({
        threadId: t.id,
        mailboxId,
        replyToMessageId: m.id,
        gmailDraftId: draftId,
        toAddress: "dana@x.com",
        subject: "Re",
        body: "Hi",
        reason: "r",
        sendAfter: new Date(NOW.getTime() + 20_000),
      })
      .returning();
    expect(await resortThread(workspaceId, t.id, "noise", { writerFor: () => writer })).toBe(
      "sending",
    );
    await database.update(drafts).set({ sendAfter: null }).where(eq(drafts.id, d!.id));
    expect(await resortThread(workspaceId, t.id, "noise", { writerFor: () => writer })).toBe(
      "moved",
    );
    const [after] = await database.select().from(drafts).where(eq(drafts.id, d!.id));
    expect(after!.status).toBe("discarded");
    expect(writer.drafts.has(draftId)).toBe(false);
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "thread_resorted"));
    expect(logs[0]!.detail).toEqual({ from: "scheduling", to: "noise" });
  });
});

describe("G7 private notes", () => {
  it("saves, replaces and removes a note keyed on the reply address, never a robot", async () => {
    const t = await thread("t1");
    const m = await message(t.id, "m1", {
      fromAddress: "form-submission@squarespace.info",
      replyToHeader: { address: "dana@x.com", name: "Dana" },
    });
    expect(await saveNote(workspaceId, m.id, "Gate code 4411")).toBe("saved");
    expect(await saveNote(workspaceId, m.id, "Big dog, prefers texts")).toBe("saved");
    expect(await noteFor(workspaceId, "dana@x.com")).toBe("Big dog, prefers texts");
    expect(await saveNote(workspaceId, m.id, "x".repeat(201))).toBe("too_long");
    expect(await saveNote(workspaceId, m.id, "   ")).toBe("empty");
    // Older than Dana's email, so hers stays the newest (a tie has no order: Check 30 P1's
    // indexes changed which tied row came first).
    const u = await message(t.id, "u1", {
      fromAddress: "a@b.com",
      replyToHeader: null,
      sentAt: daysAgo(2),
    });
    expect(await saveNote(workspaceId, u.id, "hi")).toBe("unchecked");
    const r = await message(t.id, "r1", { fromAddress: "noreply@b.com", sentAt: daysAgo(2) });
    expect(await saveNote(workspaceId, r.id, "hi")).toBe("robot");
    // A crew member's reply to a forward never decides whose note shows.
    await message(t.id, "fwd", {
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["mike@shop.com"],
      subject: "Fwd: lead",
      sentAt: daysAgo(0.5),
    });
    await message(t.id, "crew", {
      fromAddress: "mike@shop.com",
      subject: "Re: Fwd: lead",
      sentAt: daysAgo(0.4),
    });
    const byThread = await notesForThreads(workspaceId, [t.id]);
    expect(byThread.get(t.id)?.note).toBe("Big dog, prefers texts");
    expect(await removeNote(workspaceId, m.id)).toBe(true);
    expect(await noteFor(workspaceId, "dana@x.com")).toBeNull();
  });

  it("goes with the Gmail address it was written under", async () => {
    const t = await thread("t1");
    const m = await message(t.id, "m1", { fromAddress: "dana@x.com" });
    await saveNote(workspaceId, m.id, "Gate code 4411");
    await database.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(await database.select().from(customerNotes)).toHaveLength(0);
  });

  it("BOUNDARY: notes are read only by the notes module, the pages and the schema", () => {
    const allowed = [
      "src/server/customer-notes.ts",
      "src/db/schema.ts",
      "src/app/(app)/customers/[key]/page.tsx",
      "src/app/(app)/customers/actions.ts",
      "src/app/(app)/queue/page.tsx",
      "src/app/(app)/inbox/page.tsx",
    ];
    const files = execSync("grep -rlE 'customer-notes|customerNotes|customer_notes' src", {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const f of files) expect(allowed, f).toContain(f);
    for (const dir of ["src/ai", "src/server/digest.ts", "src/server/admin.ts"])
      expect(files.some((f) => f.startsWith(dir))).toBe(false);
  });
});

describe("E7 away mode", () => {
  it("pauses nudges, adds one away note outside the five, and turns off", async () => {
    await database.insert(businessProfiles).values({ workspaceId }).onConflictDoNothing();
    const [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(await turnAwayOn(ws!, "2026-10-14", { now: NOW })).toBe("past");
    expect(await turnAwayOn(ws!, "2027-03-01", { now: NOW })).toBe("too_far");
    expect(await turnAwayOn(ws!, "2026-10-17", { now: NOW })).toBe("ok");
    expect(await turnAwayOn(ws!, "2026-10-18", { now: NOW })).toBe("ok");
    const notes = await database.select().from(seasonalNotes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ away: true, endsOn: "2026-10-17" });
    expect(notes[0]!.text).toContain("Back Sunday, October 18 (Oct 18).");
    for (let i = 0; i < 5; i++)
      await addSeasonalNote(workspaceId, { text: `Note ${i}`, endsOn: "2026-11-01" }, NOW);
    const active = await activeNotes(workspaceId, NOW);
    expect(active).toHaveLength(6);
    expect(active[0]!.away).toBe(true);
    // Nudges pause, and a nudge asked for anyway is skipped.
    const t = await thread("t1", { category: "quote_request" });
    await message(t.id, "in1", { fromAddress: "dana@x.com", sentAt: daysAgo(10) });
    await message(t.id, "out1", {
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: ["dana@x.com"],
      sentAt: daysAgo(5),
    });
    expect(await threadsToFollowUp(mailboxId, NOW)).toEqual([]);
    expect(
      await createDraftForThread(t.id, {
        trigger: "followup",
        writerFor: () => new FakeWriter(),
        now: () => NOW,
      }),
    ).toEqual({ status: "skipped", reason: "away" });
    // The day back: nudges pick up again (no job had to turn it off).
    expect((await awayState(workspaceId, new Date("2026-10-18T12:00:00Z"))).on).toBe(false);
    expect(await threadsToFollowUp(mailboxId, new Date("2026-10-18T12:00:00Z"))).toEqual([t.id]);
    await turnAwayOff(workspaceId, NOW);
    expect((await awayState(workspaceId, NOW)).on).toBe(false);
    expect((await database.select().from(seasonalNotes)).filter((n) => n.away)).toHaveLength(0);
  });

  it("a default-zone owner's browser zone decides 'today'", async () => {
    await database.insert(businessProfiles).values({ workspaceId }).onConflictDoNothing();
    const [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    // 03:00Z on the 15th is still the 14th in Los Angeles.
    const late = new Date("2026-10-15T03:00:00Z");
    expect(
      await turnAwayOn(ws!, "2026-10-15", { now: late, timeZone: "America/Los_Angeles" }),
    ).toBe("ok");
    const [p] = await database.select().from(businessProfiles);
    expect(p!.timeZone).toBe("America/Los_Angeles");
  });
});
