import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { activityLog, drafts, mailboxes, messages, rules, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { sendAccessLostAlerts } from "@/server/alerts";
import { unsortedSweepMailboxes } from "@/server/assistant-status";
import { runAutopilotSend } from "@/server/autopilot";
import { applySubscription } from "@/server/billing";
import { planLookupKey } from "@/server/billing-rules";
import { classifyPending } from "@/server/classification";
import {
  batchCandidates,
  createDraftForThread,
  listQueue,
  queueCounts,
  queueSend,
  reconcileDrafts,
  reviseDraft,
  saveDraftEdit,
  sendDraft,
} from "@/server/drafts";
import { digestCounts } from "@/server/digest";
import { threadsToFollowUp } from "@/server/followups";
import { fitAllMailboxesToPlans, fitMailboxesToPlan, swapPlanMailbox } from "@/server/mailbox-plan";
import {
  fitToPlan,
  MAILBOX_PAUSED_LINE,
  mailboxLimitFor,
  mailboxOn,
  planPausedLine,
} from "@/server/mailbox-plan-rules";
import { disconnectMailbox, listMailboxes, saveConnectedMailbox } from "@/server/mailboxes";
import { freshLeads } from "@/server/sms-alerts";
import { incrementalSync, listSyncableMailboxes } from "@/server/sync";
import { learnVoice, workspacesNeedingVoice } from "@/server/voice";
import { setWorkspacePlan } from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeMailbox } from "../support/fake-mailbox";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-16T14:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let database: Database;
let workspaceId: string;
let boxes: string[];
let writer: FakeWriter;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

const box = async (id: string) =>
  (await database.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
const pausedIds = async () =>
  (await database.select().from(mailboxes).where(eq(mailboxes.workspaceId, workspaceId)))
    .filter((m) => m.planPausedAt)
    .map((m) => m.id)
    .sort();

/** A Crew account (3 Gmail addresses), active and really paid, with three connected. */
beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  await database
    .update(workspaces)
    .set({ plan: "crew", status: "active", setupPaidVia: "stripe", setupPaidAt: at(-30) })
    .where(eq(workspaces.id, workspaceId));
  boxes = [];
  for (const [i, email] of ["owner@shop.com", "office@shop.com", "jobs@shop.com"].entries()) {
    const m = await saveConnectedMailbox(
      { id: workspaceId, plan: "crew" },
      { email, refreshToken: `rt${i}`, grantedScopes: [] },
    );
    // Connected a day apart: the first is the oldest.
    await database
      .update(mailboxes)
      .set({ createdAt: at(-10 + i), backfillCompletedAt: at(-9), lastSyncedAt: NOW })
      .where(eq(mailboxes.id, m.id));
    boxes.push(m.id);
  }
  writer = new FakeWriter();
});
afterEach(() => setModelTransportForTests(undefined));

describe("rules", () => {
  it("the plan's limit; one before a plan is chosen", () => {
    expect(mailboxLimitFor(null)).toBe(1);
    expect(mailboxLimitFor("solo")).toBe(1);
    expect(mailboxLimitFor("crew")).toBe(3);
    expect(mailboxLimitFor("company")).toBe(10);
    expect(planPausedLine(1)).toBe("Paused: your plan covers 1 Gmail address.");
    expect(planPausedLine(3)).toBe("Paused: your plan covers 3 Gmail addresses.");
    expect(MAILBOX_PAUSED_LINE).toBe("This Gmail address is paused on your plan.");
  });

  it("keeps the oldest on, pauses the newest; refills the oldest paused when there's room", () => {
    const b = (id: string, day: number, paused = false) => ({
      id,
      createdAt: at(day),
      planPausedAt: paused ? NOW : null,
    });
    expect(fitToPlan([b("c", -1), b("a", -3), b("b", -2)], 1)).toEqual({
      pause: ["b", "c"],
      unpause: [],
    });
    expect(fitToPlan([b("a", -3, true), b("b", -2), b("c", -1, true)], 3)).toEqual({
      pause: [],
      unpause: ["a", "c"],
    });
    // The owner's swap is kept: b on, a paused, limit 1 → nothing changes.
    expect(fitToPlan([b("a", -3, true), b("b", -2)], 1)).toEqual({ pause: [], unpause: [] });
    expect(mailboxOn({ status: "active", planPausedAt: null })).toBe(true);
    expect(mailboxOn({ status: "active", planPausedAt: NOW })).toBe(false);
    expect(mailboxOn({ status: "reconnect_needed", planPausedAt: null })).toBe(false);
  });
});

describe("a lower plan pauses the extra Gmail addresses", () => {
  it("admin's setWorkspacePlan: Crew → Solo keeps the oldest on; data is kept; one log line", async () => {
    await database.insert(threads).values({ mailboxId: boxes[2]!, gmailThreadId: "kept" });
    await setWorkspacePlan(workspaceId, "solo", NOW);
    expect(await pausedIds()).toEqual([boxes[1]!, boxes[2]!].sort());
    expect((await box(boxes[0]!)).planPausedAt).toBeNull();
    // Nothing is deleted.
    expect(await database.select().from(threads)).toHaveLength(1);
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mailboxes_fit_plan"));
    expect(logs.map((l) => l.detail)).toEqual([{ paused: 2, resumed: 0, limit: 1 }]);
    // Running it again changes nothing.
    expect(await fitMailboxesToPlan(workspaceId, NOW)).toEqual({ paused: 0, resumed: 0 });
  });

  it("Stripe's webhook moving to a cheaper plan pauses too; moving up turns them back on", async () => {
    const sub = (plan: "solo" | "crew" | "company") =>
      ({
        id: "sub_1",
        status: "active",
        metadata: { workspaceId },
        items: { data: [{ price: { lookup_key: planLookupKey(plan) } }] },
      }) as unknown as Stripe.Subscription;
    await applySubscription(sub("solo"), NOW);
    expect(await pausedIds()).toEqual([boxes[1]!, boxes[2]!].sort());
    await applySubscription(sub("company"), NOW);
    expect(await pausedIds()).toEqual([]);
  });

  it("an autopilot countdown on a paused address stops", async () => {
    const t = await thread(boxes[2]!, "g-auto");
    const d = await pendingDraft(t, boxes[2]!, { autoSendAt: at(0.005) });
    await setWorkspacePlan(workspaceId, "solo", NOW);
    expect((await draftRow(d)).autoSendAt).toBeNull();
  });

  it("upgrading again un-pauses up to the new limit, oldest first", async () => {
    await setWorkspacePlan(workspaceId, "solo", NOW);
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspaceId));
    // A 4th address can't exist on Crew, so the limit is reached exactly.
    expect(await fitMailboxesToPlan(workspaceId, NOW)).toEqual({ paused: 0, resumed: 2 });
    expect(await pausedIds()).toEqual([]);
  });

  it("the 15-minute backstop fits accounts a plan change left over the limit", async () => {
    await database.update(workspaces).set({ plan: "solo" }).where(eq(workspaces.id, workspaceId));
    expect(await fitAllMailboxesToPlans(NOW)).toBe(1);
    expect(await pausedIds()).toHaveLength(2);
    expect(await fitAllMailboxesToPlans(NOW)).toBe(0);
  });

  it("disconnecting the one that's on brings a paused one back", async () => {
    await setWorkspacePlan(workspaceId, "solo", NOW);
    await disconnectMailbox(workspaceId, boxes[0]!, { revoke: async () => {} } as never);
    expect((await box(boxes[1]!)).planPausedAt).toBeNull();
    expect((await box(boxes[2]!)).planPausedAt).not.toBeNull();
  });

  it("listMailboxes tells the screen which are paused", async () => {
    await setWorkspacePlan(workspaceId, "solo", NOW);
    const listed = await listMailboxes(workspaceId);
    expect(listed.filter((m) => m.planPausedAt).map((m) => m.email)).toEqual([
      "office@shop.com",
      "jobs@shop.com",
    ]);
  });
});

describe("'Use this one instead': the owner picks which is on", () => {
  beforeEach(async () => {
    await setWorkspacePlan(workspaceId, "solo", NOW);
  });

  it("swaps one for one; the server keeps the count at the limit", async () => {
    expect(await swapPlanMailbox(workspaceId, boxes[2]!, boxes[0]!, NOW)).toBe("swapped");
    expect(await pausedIds()).toEqual([boxes[0]!, boxes[1]!].sort());
    // The swap survives the backstop (the owner's choice is kept).
    expect(await fitAllMailboxesToPlans(NOW)).toBe(0);
    expect(await pausedIds()).toEqual([boxes[0]!, boxes[1]!].sort());
  });

  it("refuses an address that's on, a replacement that's paused, and another account's", async () => {
    expect(await swapPlanMailbox(workspaceId, boxes[0]!, boxes[1]!, NOW)).toBe("not_paused");
    expect(await swapPlanMailbox(workspaceId, boxes[2]!, boxes[1]!, NOW)).toBe("choose");
    expect(await swapPlanMailbox(workspaceId, boxes[2]!, null, NOW)).toBe("choose");
    const other = await ensureUserAndWorkspace({ email: "someone@else.com" });
    expect(await swapPlanMailbox(other.workspace.id, boxes[2]!, boxes[0]!, NOW)).toBe("not_found");
    expect(await pausedIds()).toEqual([boxes[1]!, boxes[2]!].sort());
  });

  it("with room on the plan, it simply comes on (never over the limit)", async () => {
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspaceId));
    expect(await swapPlanMailbox(workspaceId, boxes[1]!, null, NOW)).toBe("resumed");
    expect(await swapPlanMailbox(workspaceId, boxes[2]!, null, NOW)).toBe("resumed");
    expect(await pausedIds()).toEqual([]);
  });

  it("the Settings screen shows the line and the button; the action re-checks on the server", () => {
    const page = readFileSync("src/app/(app)/settings/gmail/page.tsx", "utf8");
    expect(page).toContain("{planPausedLine(limit)}");
    expect(page).toContain("Use this one instead");
    const actions = readFileSync("src/app/(app)/settings/actions.ts", "utf8");
    expect(actions).toMatch(
      /export async function swapMailboxAction[\s\S]*?await requireOwner\(\)[\s\S]*?swapPlanMailbox\(workspace\.id/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Every gate

async function thread(
  mailboxId: string,
  g: string,
  over: Partial<typeof threads.$inferInsert> = {},
) {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: g,
      inInbox: true,
      subject: "Panel",
      category: "quote_request",
      classifiedAt: at(-0.1),
      lastMessageAt: at(-0.1),
      ...over,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${g}-1`,
    rfc822MessageId: `<${g}-1@x.test>`,
    direction: "in",
    fromAddress: "dana@customer.test",
    fromName: "Dana",
    subject: "Panel",
    bodyText: "Can you quote a panel?",
    replyToHeader: {},
    sentAt: at(-0.1),
  });
  return t!.id;
}

async function pendingDraft(
  threadId: string,
  mailboxId: string,
  over: Partial<typeof drafts.$inferInsert> = {},
) {
  const created = await writer.createDraft({ threadId: "g", raw: "" });
  writer.calls = [];
  const [d] = await database
    .insert(drafts)
    .values({
      threadId,
      mailboxId,
      gmailDraftId: created.draftId,
      gmailMessageId: created.messageId,
      toAddress: "dana@customer.test",
      subject: "Re: Panel",
      body: "",
      originalBody: "",
      reason: "Drafted.",
      confidence: 95,
      ...over,
    })
    .returning();
  return d!.id;
}
const draftRow = async (id: string) =>
  (await database.select().from(drafts).where(eq(drafts.id, id)))[0]!;

describe("GUARDRAIL: a paused address — nothing read, sorted, drafted, sent, alerted or learned", () => {
  let paused: string;
  beforeEach(async () => {
    await setWorkspacePlan(workspaceId, "solo", NOW);
    paused = boxes[1]!;
  });

  it("sync, the poll and Gmail watch skip it before any Gmail call", async () => {
    const fake = new FakeMailbox();
    expect(
      await incrementalSync(paused, { readerFor: () => fake.reader(), now: () => NOW }),
    ).toEqual({ status: "skipped", reason: "not_active" });
    expect(fake.calls).toBe(0);
    expect((await listSyncableMailboxes(NOW)).map((b) => b.id)).toEqual([boxes[0]]);
  });

  it("nothing is sorted (no AI) and the unsorted sweep leaves it out", async () => {
    const t = await thread(paused, "g-sort", { classifiedAt: null });
    await database
      .update(messages)
      .set({ sentAt: at(-1) })
      .where(eq(messages.threadId, t));
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    expect((await classifyPending(paused, { now: NOW })).classified).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await unsortedSweepMailboxes(NOW)).not.toContain(paused);
  });

  it("no draft for any trigger — auto, follow-up or the owner's tap — and no model call", async () => {
    const t = await thread(paused, "g-draft");
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    for (const trigger of ["auto", "followup", "owner"] as const) {
      expect(await createDraftForThread(t, { trigger, workspaceId, ...deps() })).toEqual({
        status: "skipped",
        reason: "mailbox_paused",
      });
    }
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
    expect(await threadsToFollowUp(paused, NOW)).toEqual([]);
  });

  it("send, the tap and the undo-window send refuse it with no Gmail call; the 403 line", async () => {
    const t = await thread(paused, "g-send");
    const d = await pendingDraft(t, paused);
    expect(await sendDraft(workspaceId, d, deps())).toEqual({ status: "mailbox_paused" });
    expect(await queueSend(workspaceId, d, deps())).toEqual({ status: "mailbox_paused" });
    expect(writer.calls).toEqual([]);
    expect((await draftRow(d)).status).toBe("pending");
    const route = readFileSync("src/app/api/drafts/[id]/send/route.ts", "utf8");
    expect(route).toMatch(
      /outcome\.status === "mailbox_paused"[\s\S]*?MAILBOX_PAUSED_LINE[\s\S]*?status: 403/,
    );
  });

  it("no tweak (AI), no edit written to Gmail, not in a batch, no reconcile", async () => {
    const t = await thread(paused, "g-edit");
    const d = await pendingDraft(t, paused);
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    expect(await reviseDraft(workspaceId, d, { tweak: "shorter" }, deps())).toEqual({
      status: "mailbox_paused",
    });
    expect(await saveDraftEdit(workspaceId, d, "New words", deps())).toBe("mailbox_paused");
    expect(calls).toHaveLength(0);
    expect(writer.calls).toEqual([]);
    expect((await batchCandidates(workspaceId, ["quote_request"])).map((r) => r.draftId)).toEqual(
      [],
    );
    expect(await reconcileDrafts(paused, deps())).toMatchObject({ checked: 0 });
    expect(writer.calls).toEqual([]);
  });

  it("autopilot stands down with the paused line, without asking Gmail", async () => {
    // Back on Crew (autopilot's plan) before the address was turned back on.
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspaceId));
    await database
      .insert(rules)
      .values({ workspaceId, category: "quote_request", mode: "autopilot" });
    const t = await thread(paused, "g-auto2");
    const d = await pendingDraft(t, paused, { autoSendAt: at(-0.01) });
    const r = await runAutopilotSend(d, deps());
    expect(r).toEqual({ status: "stood_down", reasons: [MAILBOX_PAUSED_LINE] });
    expect(writer.calls).toEqual([]);
  });

  it("no new-lead alerts, no Gmail-access emails, no voice learning from it", async () => {
    await thread(paused, "g-lead");
    expect(await freshLeads(workspaceId, null, NOW)).toEqual([]);
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed", accessLostAt: NOW })
      .where(eq(mailboxes.id, paused));
    const sent: string[] = [];
    await sendAccessLostAlerts(NOW, {
      send: async (e) => {
        sent.push(e.subject);
        return "sent";
      },
    });
    expect(sent).toEqual([]);
    // Voice is learned from the oldest address that's on, never a paused one.
    await database.update(mailboxes).set({ planPausedAt: NOW }).where(eq(mailboxes.id, boxes[0]!));
    expect(await learnVoice(workspaceId, { readerFor: () => new FakeMailbox().reader() })).toBe(
      "no_mailbox",
    );
    expect(await workspacesNeedingVoice(NOW)).toEqual([]);
  });

  it("the queue still shows its drafts, marked paused (nothing is hidden or deleted)", async () => {
    const t = await thread(paused, "g-q");
    await pendingDraft(t, paused, { body: "Hi Dana", originalBody: "Hi Dana" });
    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts.map((i) => i.mailboxPaused)).toEqual([true]);
    const page = readFileSync("src/app/(app)/queue/page.tsx", "utf8");
    expect(page).toContain("canSend={sending && !i.mailboxPaused}");
    expect(page).toContain("i.mailboxPaused ? MAILBOX_PAUSED_LINE");
  });

  it("integration: the morning email's counts leave out a paused address; the queue still shows it", async () => {
    const onBox = boxes[0]!;
    const tOn = await thread(onBox, "g-on");
    await pendingDraft(tOn, onBox, { body: "Hi Dana", originalBody: "Hi Dana" });
    const tPaused = await thread(paused, "g-off");
    await pendingDraft(tPaused, paused, { body: "Hi Sam", originalBody: "Hi Sam" });
    await thread(paused, "g-off-needs", { needsOwner: true });
    await thread(onBox, "g-on-needs", { needsOwner: true });

    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts.map((i) => i.mailboxPaused).sort()).toEqual([false, true]);
    expect(q.needsYou.map((i) => i.mailboxPaused).sort()).toEqual([false, true]);

    expect(await queueCounts(workspaceId, NOW)).toEqual({
      needsYou: 1,
      replies: 1,
      nudges: 0,
      drafts: 1,
    });
    const c = await digestCounts(workspaceId, NOW, "America/New_York");
    expect(c.repliesReady).toBe(1);
    expect(c.nudgesReady).toBe(0);
    expect(c.needsYou).toHaveLength(1);
  });

  it("STATIC: the emergency alerts and the trial emails use the shared pause helpers", () => {
    const emergency = readFileSync("src/server/emergency-alerts.ts", "utf8");
    expect(emergency).toContain("mailboxRunning()");
    expect(emergency).not.toMatch(/eq\(mailboxes\.status, "active"\)/);
    const trial = readFileSync("src/server/trial-emails.ts", "utf8");
    expect(trial).toContain("notPlanPaused()");
    // Their counts: queueCounts leaves paused addresses out (countQueue → actionableQueue).
    expect(trial).toContain("queueCounts(");
    expect(readFileSync("src/server/drafts.ts", "utf8")).toMatch(
      /export function countQueue\([^)]*\)[^{]*\{\s*const q = actionableQueue\(/,
    );
  });

  it("STATIC: every job that skips a lost mailbox skips a paused one too", () => {
    // No mailbox-status-only gate is left in the server code: each goes through
    // mailboxRunning() / mailboxOn() (or reads planPausedAt next to it). Reviewed exceptions:
    // markReconnectNeeded (flags a working mailbox lost) and deleting an expired draft in Gmail.
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
      });
    const offenders: string[] = [];
    for (const f of [...files("src/server"), ...files("src/app/api"), ...files("src/jobs")]) {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (/eq\(mailboxes\.status, "active"\)|mailbox\.status !== "active"/.test(line)) {
          const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          if (/planPausedAt/.test(near)) return;
          offenders.push(`${f}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([
      'src/server/sync.ts: .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.status, "active")))',
    ]);
  });
});

describe("old code against the new column", () => {
  it("a mailbox nobody paused reads as on (the column is null by default)", async () => {
    const [b] = await database
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, workspaceId), eq(mailboxes.id, boxes[0]!)));
    expect(b!.planPausedAt).toBeNull();
  });
});
