import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import {
  activityLog,
  drafts,
  messages,
  rules,
  threads,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  accountLockReason,
  AutopilotNotAllowedError,
  considerAutopilot,
  DAILY_AUTOPILOT_CAP,
  EARN_THRESHOLD,
  earnedCounts,
  GRACE_MINUTES,
  guardrailReasons,
  holdAutopilot,
  overdueAutopilotDrafts,
  runAutopilotSend,
  setAutopilot,
  type GuardrailInput,
} from "@/server/autopilot";
import { createDraftForThread, saveDraftEdit, threadsToAutoDraft } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  autopilotPlanEffects,
  enforcePlanAutopilot,
  setWorkspacePlan,
} from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T14:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const cleanDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nThursday morning works on our end — see you then.\n\nThanks, Davi",
  reason: "Scheduling. Confirmed the visit.",
  flags: [],
  confidence: 0.95,
  used_facts: [],
  ...over,
});

describe("account lock (layer 1)", () => {
  const w = (
    plan: Workspace["plan"],
    status: Workspace["status"],
    setupPaidVia: Workspace["setupPaidVia"] = "stripe",
  ) => ({
    plan,
    freePlan: null,
    freePlanUntil: null,
    status,
    evaluationEndsAt: null,
    setupPaidVia,
  });
  it("needs Crew or Company AND a finished setup", () => {
    expect(accountLockReason(w(null, "active"))).toMatch(/Crew and Company/);
    expect(accountLockReason(w("solo", "active"))).toMatch(/Crew and Company/);
    expect(accountLockReason(w("crew", "evaluating"))).toMatch(/setup call/);
    expect(accountLockReason(w("crew", "setup_paid"))).toMatch(/setup call/);
    expect(accountLockReason(w("crew", "paused"))).toMatch(/setup call/);
    expect(accountLockReason(w("crew", "active"))).toBeNull();
    expect(accountLockReason(w("company", "active"))).toBeNull();
    expect(accountLockReason(w("crew", "active", "house"))).toBeNull();
  });

  it("GUARDRAIL: needs a real setup payment too (hand-marked or reset after a test card)", () => {
    expect(accountLockReason(w("crew", "active", null))).toBe(
      "Autopilot opens up once your setup payment goes through.",
    );
    expect(accountLockReason(w("company", "active", null))).toMatch(/setup payment/);
  });
});

describe("per-email guardrails (layer 3)", () => {
  const ok: GuardrailInput = {
    category: "scheduling",
    needsOwner: false,
    kind: "reply",
    confidencePct: 92,
    flags: [],
    amountsInEmail: [],
    draftBody: "Thursday works.",
    knownCustomer: true,
    purpose: null,
  };
  it("a clean reply to a known customer may go", () => {
    expect(guardrailReasons(ok)).toEqual([]);
  });
  it.each([
    ["complaints", { category: "complaint" }],
    ["noise", { category: "noise" }],
    ["anything flagged for the owner", { needsOwner: true }],
    ["follow-ups", { kind: "followup" as const }],
    ["low confidence", { confidencePct: 84 }],
    ["missing confidence", { confidencePct: null }],
    ["drafts with things to check", { flags: ["Check you can do Thursday."] }],
    ["invoices with an amount", { category: "invoice_payment", amountsInEmail: [450] }],
    ["any draft that mentions money", { draftBody: "That's $95 for the call-out." }],
    ["people the owner has never written to", { knownCustomer: false }],
    ["quote acceptances", { acceptsQuote: true }],
    ["deposit details (#28)", { purpose: "deposit" }],
    ["review requests (#29)", { purpose: "review_request" }],
    ["closing questions (#26)", { purpose: "closing_question" }],
    ["a stored Gmail draft after the email, not yet checked", { maybeAnswered: true }],
  ])("never: %s", (_label, change) => {
    expect(guardrailReasons({ ...ok, ...change }).length).toBeGreaterThan(0);
  });
  it("purpose notes always wait for the owner, with a plain reason", () => {
    for (const purpose of ["deposit", "review_request", "closing_question"]) {
      expect(guardrailReasons({ ...ok, purpose })).toContain(
        "Deposit, review and closing notes always wait for you.",
      );
    }
  });
  it("an invoice question with no amount is allowed", () => {
    expect(guardrailReasons({ ...ok, category: "invoice_payment" })).toEqual([]);
  });
});

describe("in the database", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  let g = 0;
  const deps = (at = NOW) => ({ writerFor: () => writer, now: () => at });
  const ws = async () =>
    (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!;

  /** A conversation with Dana; by default the owner has written to her before. */
  async function conversation(
    opts: { category?: string; known?: boolean; from?: string; needsOwner?: boolean } = {},
  ) {
    const id = `g${++g}`;
    const from = opts.from ?? "dana@customer.com";
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: id,
        inInbox: true,
        subject: "Visit",
        category: opts.category ?? "scheduling",
        needsOwner: opts.needsOwner ?? false,
        classifiedAt: NOW,
        lastMessageAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    if (opts.known ?? true) {
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-earlier`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: [from],
        bodyText: "Earlier job, thanks.",
        sentAt: new Date(NOW.getTime() - 30 * 86_400_000),
      });
    }
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in`,
      rfc822MessageId: `<${id}@customer.com>`,
      direction: "in",
      fromAddress: from,
      fromName: "Dana Ruiz",
      subject: "Visit",
      bodyText: "Can you come Thursday morning?",
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    return t!.id;
  }

  async function drafted(threadId: string, model: ModelDraft = cleanDraft()) {
    setModelTransportForTests(fakeTransport([model]).transport);
    const r = await createDraftForThread(threadId, { trigger: "auto", ...deps() });
    if (r.status !== "created") throw new Error(`no draft: ${JSON.stringify(r)}`);
    return r.draftId;
  }

  /** Evidence: n replies in a category sent exactly as drafted. */
  async function earn(category: string, n: number, status: "sent" | "edited_and_sent" = "sent") {
    for (let i = 0; i < n; i++) {
      const t = await conversation({ category });
      await database.insert(drafts).values({
        threadId: t,
        mailboxId,
        gmailDraftId: `earned-${t}`,
        sentGmailMessageId: `sent-${t}`,
        toAddress: "dana@customer.com",
        subject: "Re",
        body: "b",
        originalBody: "b",
        status,
        reason: "r",
        promptVersion: "draft.v1",
        createdAt: new Date(NOW.getTime() - 86_400_000),
        decidedAt: new Date(NOW.getTime() - 86_400_000),
      });
    }
  }

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "500";
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
      .set({ status: "active", plan: "crew", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    writer = new FakeWriter();
  });

  describe("turning it on (layer 2)", () => {
    it(`needs ${EARN_THRESHOLD} replies in that category sent without edits`, async () => {
      await earn("scheduling", EARN_THRESHOLD - 1);
      await earn("scheduling", 5, "edited_and_sent"); // edited ones don't count
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toBeInstanceOf(
        AutopilotNotAllowedError,
      );
      await earn("scheduling", 1);
      await setAutopilot(await ws(), "scheduling", true, NOW);
      const [r] = await database.select().from(rules);
      expect(r).toMatchObject({ category: "scheduling", mode: "autopilot" });
    });

    it("GUARDRAIL: deposit, review and closing notes sent as drafted never count toward earning it", async () => {
      await earn("scheduling", EARN_THRESHOLD);
      // Mark three of them as purpose notes (#26 #28 #29): autopilot can never send those,
      // so approving them proves nothing about ordinary replies.
      const rows = await database.select({ id: drafts.id }).from(drafts);
      const purposes = ["deposit", "review_request", "closing_question"] as const;
      for (const [i, purpose] of purposes.entries()) {
        await database.update(drafts).set({ purpose }).where(eq(drafts.id, rows[i]!.id));
      }
      expect((await earnedCounts(workspaceId)).get("scheduling")).toBe(EARN_THRESHOLD - 3);
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toThrow(
        /Needs 3 more/,
      );
    });

    it("is refused on the wrong plan or before setup is done, and never for complaints", async () => {
      await earn("scheduling", EARN_THRESHOLD);
      await earn("complaint", EARN_THRESHOLD);
      await database.update(workspaces).set({ plan: "solo" });
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toThrow(/Crew/);
      await database
        .update(workspaces)
        .set({ plan: "crew", status: "setup_paid", setupPaidVia: "stripe" });
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toThrow(/setup/);
      await database.update(workspaces).set({ status: "active", setupPaidVia: "stripe" });
      await expect(setAutopilot(await ws(), "complaint", true, NOW)).rejects.toBeInstanceOf(
        AutopilotNotAllowedError,
      );
    });
  });

  describe("the grace window and the send", () => {
    beforeEach(async () => {
      await earn("scheduling", EARN_THRESHOLD);
      await setAutopilot(await ws(), "scheduling", true, NOW);
    });

    it(`waits ${GRACE_MINUTES} minutes, checks again, then sends as autopilot`, async () => {
      const draftId = await drafted(await conversation());
      const at = await considerAutopilot(draftId, NOW);
      expect(at).toEqual(later(GRACE_MINUTES));

      expect(await runAutopilotSend(draftId, deps(later(5)))).toEqual({ status: "not_due" });
      expect(writer.sent).toHaveLength(0);

      expect(await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)))).toEqual({
        status: "sent",
      });
      expect(writer.sent).toHaveLength(1);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d!.status).toBe("sent");
      const [log] = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "reply_sent"));
      expect(log).toMatchObject({ actor: "squared_away", detail: { autopilot: true } });

      // Running again (a retried job) does nothing.
      expect(await runAutopilotSend(draftId, deps(later(20)))).toEqual({ status: "gone" });
      expect(writer.sent).toHaveLength(1);
    });

    it("Hold it: never sends, and it waits for the owner's tap", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      expect(await holdAutopilot(workspaceId, draftId)).toBe(true);
      expect(await runAutopilotSend(draftId, deps(later(30)))).toMatchObject({
        status: "stood_down",
      });
      expect(writer.sent).toHaveLength(0);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d).toMatchObject({ status: "pending", autoSendAt: null });
    });

    it("someone else can't hold (or see) another owner's draft", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
      expect(await holdAutopilot(other.id, draftId)).toBe(false);
    });

    it("an owner edit stands autopilot down", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      await saveDraftEdit(workspaceId, draftId, "Hi Dana, Thursday at 8 works.", deps());
      expect(await runAutopilotSend(draftId, deps(later(30)))).toMatchObject({
        status: "stood_down",
      });
      expect(writer.sent).toHaveLength(0);
    });

    it("new mail in the conversation stands it down", async () => {
      const t = await conversation();
      const draftId = await drafted(t);
      await considerAutopilot(draftId, NOW);
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: "customer-again",
        direction: "in",
        fromAddress: "dana@customer.com",
        bodyText: "Actually, can we do Friday?",
        sentAt: later(3),
      });
      expect(await runAutopilotSend(draftId, deps(later(30)))).toMatchObject({
        status: "stood_down",
      });
      expect(writer.sent).toHaveLength(0);
    });

    it("GUARDRAIL: the owner writing their own reply in Gmail stands it down", async () => {
      const t = await conversation();
      const draftId = await drafted(t);
      await considerAutopilot(draftId, NOW);
      // During the window the owner starts a reply in Gmail: an autosaved draft on the thread.
      const [thread] = await database.select().from(threads).where(eq(threads.id, t));
      await writer.createDraft({ threadId: thread!.gmailThreadId, raw: "" });
      const r = await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)));
      expect(r).toEqual({ status: "stood_down", reasons: ["You're writing a reply in Gmail."] });
      expect(writer.sent).toHaveLength(0);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d).toMatchObject({ status: "pending", autoSendAt: null });
      // A draft on another thread, or ours alone, doesn't hold it.
      const other = await conversation();
      const second = await drafted(other);
      await considerAutopilot(second, NOW);
      await writer.createDraft({ threadId: "some-other-thread", raw: "" });
      expect(await runAutopilotSend(second, deps(later(GRACE_MINUTES)))).toEqual({
        status: "sent",
      });
    });

    it("asks Gmail about other drafts only when sending is allowed (no Google call when blocked)", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      // Marked active by hand before real payment: sending is blocked, so it stands down (it
      // used to reach sendDraft and throw, and the backstop retried it forever).
      await database.update(workspaces).set({ setupPaidVia: null });
      writer.calls = [];
      expect(await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)))).toEqual({
        status: "stood_down",
        reasons: ["Autopilot opens up once your setup payment goes through."],
      });
      expect(writer.calls).toEqual([]);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d!.autoSendAt).toBeNull();
      expect(d!.status).toBe("pending");
      expect(await overdueAutopilotDrafts(later(60))).not.toContain(draftId);
    });

    it("GUARDRAIL: an active account without a real setup payment never starts a countdown", async () => {
      // What "Reset test payments" leaves: active, Crew, autopilot still switched on.
      await database.update(workspaces).set({ setupPaidVia: null });
      const draftId = await drafted(await conversation());
      expect(await considerAutopilot(draftId, NOW)).toBeNull();
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d!.autoSendAt).toBeNull();
      // Its settings stay as they were, and come back once a real payment lands.
      expect((await database.select().from(rules))[0]!.mode).toBe("autopilot");
      await database.update(workspaces).set({ setupPaidVia: "stripe" });
      expect(await considerAutopilot(draftId, NOW)).toEqual(later(GRACE_MINUTES));
    });

    it("GUARDRAIL: waits while a stored draft after the customer's email isn't checked with Gmail", async () => {
      // Old sync stored Gmail drafts as owner mail. If Gmail sent this one under the same id,
      // the owner already answered: no auto-draft, no countdown, until the cleanup checks it.
      const storedDraft = async (threadId: string, labelIds: string[]) => {
        await database.insert(messages).values({
          threadId,
          mailboxId,
          gmailMessageId: `${threadId}-stored-${labelIds.join("-")}`,
          direction: "out",
          fromAddress: "owner@shop.com",
          toAddresses: ["dana@customer.com"],
          labelIds,
          sentAt: new Date(NOW.getTime() - 30 * 60_000),
        });
      };
      const t = await conversation();
      await storedDraft(t, ["DRAFT"]);
      expect(await threadsToAutoDraft(mailboxId)).not.toContain(t);
      // A draft written anyway (as the owner's "Draft a reply" would) never counts down.
      const draftId = await drafted(t);
      expect(await considerAutopilot(draftId, NOW)).toBeNull();

      // The same thread without that row: drafted, and the countdown starts.
      const clean = await conversation();
      expect(await threadsToAutoDraft(mailboxId)).toContain(clean);
      expect(await considerAutopilot(await drafted(clean), NOW)).toEqual(later(GRACE_MINUTES));

      // Gmail said it was sent under the same id (relabelled SENT): the owner answered, so
      // still no auto-draft.
      const answered = await conversation();
      await storedDraft(answered, ["DRAFT", "SENT"]);
      expect(await threadsToAutoDraft(mailboxId)).not.toContain(answered);
    });

    it("switching autopilot off, a plan change, or a paused account all stop a countdown", async () => {
      const a = await drafted(await conversation());
      await considerAutopilot(a, NOW);
      await setAutopilot(await ws(), "scheduling", false, NOW);
      expect(
        (await database.select().from(drafts).where(eq(drafts.id, a)))[0]!.autoSendAt,
      ).toBeNull();

      await setAutopilot(await ws(), "scheduling", true, NOW);
      const b = await drafted(await conversation());
      await considerAutopilot(b, NOW);
      await setWorkspacePlan(workspaceId, "solo", NOW);
      expect(await runAutopilotSend(b, deps(later(30)))).toMatchObject({ status: "stood_down" });
      expect((await database.select().from(rules))[0]!.mode).toBe("draft");

      await setWorkspacePlan(workspaceId, "crew", NOW);
      await setAutopilot(await ws(), "scheduling", true, NOW);
      const c = await drafted(await conversation());
      await considerAutopilot(c, NOW);
      await database.update(workspaces).set({ status: "paused" });
      expect(await runAutopilotSend(c, deps(later(30)))).toMatchObject({ status: "stood_down" });
      expect(writer.sent).toHaveLength(0);
    });

    it("GUARDRAIL: a first reply to a new lead (draft.v7) never goes on its own", async () => {
      const draftId = await drafted(await conversation());
      await database.update(drafts).set({ opening: "details" }).where(eq(drafts.id, draftId));
      expect(await considerAutopilot(draftId, NOW)).toBeNull();
      // Even the model's "not_first" on a first contact: the code said first contact.
      await database.update(drafts).set({ opening: "not_first" }).where(eq(drafts.id, draftId));
      expect(await considerAutopilot(draftId, NOW)).toBeNull();
      await database.update(drafts).set({ opening: null }).where(eq(drafts.id, draftId));
      expect(await considerAutopilot(draftId, NOW)).toEqual(later(GRACE_MINUTES));
      // And at send time too: a countdown never survives a first-reply mark.
      await database.update(drafts).set({ opening: "vague" }).where(eq(drafts.id, draftId));
      expect(await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)))).toMatchObject({
        status: "stood_down",
        reasons: expect.arrayContaining(["First replies to new customers always wait for you."]),
      });
      expect(writer.sent).toHaveLength(0);
    });

    it("doesn't start for strangers, money, flags, low confidence, complaints or other categories", async () => {
      const cases = [
        await drafted(await conversation({ known: false, from: "new@person.com" })),
        await drafted(
          await conversation(),
          cleanDraft({ body: "Hi Dana, it's $95 for the visit." }),
        ),
        await drafted(await conversation(), cleanDraft({ flags: ["Check Thursday works."] })),
        await drafted(await conversation(), cleanDraft({ confidence: 0.7 })),
        await drafted(await conversation({ category: "customer_question" })), // autopilot not on
      ];
      for (const d of cases) expect(await considerAutopilot(d, NOW)).toBeNull();
      // Complaints aren't even auto-drafted; drafted by the owner, they still can't go.
      const t = await conversation({ category: "complaint", needsOwner: true });
      setModelTransportForTests(fakeTransport([cleanDraft()]).transport);
      const r = await createDraftForThread(t, { trigger: "owner", workspaceId, ...deps() });
      if (r.status !== "created") throw new Error("expected a draft");
      expect(await considerAutopilot(r.draftId, NOW)).toBeNull();
      expect(await overdueAutopilotDrafts(later(60))).toEqual([]);
    });

    it("GUARDRAIL: an unsent Gmail draft to someone isn't 'written to them before'", async () => {
      // Old sync stored Gmail drafts as owner mail; a draft never sent can't make them known.
      const writtenBefore = async (from: string, labelIds: string[]) => {
        const t = await conversation({ known: false, from });
        await database.insert(messages).values({
          threadId: t,
          mailboxId,
          gmailMessageId: `${t}-earlier-${labelIds.join("-")}`,
          direction: "out",
          fromAddress: "owner@shop.com",
          toAddresses: [from],
          labelIds,
          bodyText: "Earlier note.",
          sentAt: new Date(NOW.getTime() - 2 * 86_400_000),
        });
        return drafted(t);
      };
      const onlyDraft = await writtenBefore("fresh@person.com", ["DRAFT"]);
      expect(await considerAutopilot(onlyDraft, NOW)).toBeNull();
      // The same with a real sent email: they're known, and the countdown starts.
      const sent = await writtenBefore("known@person.com", ["SENT"]);
      expect(await considerAutopilot(sent, NOW)).toEqual(later(GRACE_MINUTES));
    });

    it("never starts for a quote acceptance, even one re-sorted as scheduling (A5)", async () => {
      // The owner reopened the quote (no outcome, set by the owner), then the
      // customer's "Let's do it, can you start Monday?" was sorted as scheduling,
      // which is on autopilot. The acceptance signal alone keeps it with the owner.
      const accepted = await conversation();
      await database
        .update(threads)
        .set({
          quoteOutcome: null,
          quoteOutcomeSource: "owner",
          extracted: { accepts_quote: true, quote_accepted: true, dollar_amounts: [] },
        })
        .where(eq(threads.id, accepted));
      // The deposit details already went out on this thread, so the new draft is an
      // ordinary reply (no purpose): only the acceptance guard can keep it with the owner.
      await database.insert(drafts).values({
        threadId: accepted,
        mailboxId,
        gmailDraftId: `deposit-${accepted}`,
        sentGmailMessageId: `deposit-sent-${accepted}`,
        toAddress: "dana@customer.com",
        subject: "Re: Visit",
        body: "Deposit details.",
        originalBody: "Deposit details.",
        status: "sent",
        purpose: "deposit",
        reason: "Deposit details.",
        promptVersion: "purpose.v1",
        createdAt: new Date(NOW.getTime() - 2 * 3600_000),
        decidedAt: new Date(NOW.getTime() - 2 * 3600_000),
      });
      const draftId = await drafted(accepted);
      const row = async () =>
        (await database.select().from(drafts).where(eq(drafts.id, draftId)))[0]!;
      expect((await row()).purpose).toBeNull();
      expect(await considerAutopilot(draftId, NOW)).toBeNull();
      expect((await row()).autoSendAt).toBeNull();
      // Even a countdown that somehow got set stands down at send time, for that reason.
      await database
        .update(drafts)
        .set({ autoSendAt: later(GRACE_MINUTES) })
        .where(eq(drafts.id, draftId));
      const r = await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)));
      expect(r).toMatchObject({ status: "stood_down" });
      expect(r.status === "stood_down" && r.reasons).toContain(
        "Quote acceptances always wait for you.",
      );
      expect(writer.sent).toHaveLength(0);
      // The same conversation without the signal would have gone.
      const control = await drafted(await conversation());
      expect(await considerAutopilot(control, NOW)).toEqual(later(GRACE_MINUTES));
    });

    it("GUARDRAIL: never starts a countdown for, or sends, a deposit / review / closing note", async () => {
      for (const purpose of ["deposit", "review_request", "closing_question"] as const) {
        const draftId = await drafted(await conversation());
        await database.update(drafts).set({ purpose }).where(eq(drafts.id, draftId));
        expect(await considerAutopilot(draftId, NOW)).toBeNull();
        // Even a countdown that somehow got set stands down at send time.
        await database
          .update(drafts)
          .set({ autoSendAt: later(GRACE_MINUTES) })
          .where(eq(drafts.id, draftId));
        const r = await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)));
        expect(r).toMatchObject({ status: "stood_down" });
        expect(r.status === "stood_down" && r.reasons).toContain(
          "Deposit, review and closing notes always wait for you.",
        );
      }
      expect(writer.sent).toHaveLength(0);
      expect(writer.calls).not.toContain("sendDraft");
    });

    it(`stops after ${DAILY_AUTOPILOT_CAP} a day`, async () => {
      for (let i = 0; i < DAILY_AUTOPILOT_CAP; i++) {
        await database.insert(activityLog).values({
          workspaceId,
          actor: "squared_away",
          action: "autopilot_scheduled",
          createdAt: later(-60),
        });
      }
      const draftId = await drafted(await conversation());
      expect(await considerAutopilot(draftId, NOW)).toBeNull();
    });

    it("lost send events are picked up by the backstop", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      expect(await overdueAutopilotDrafts(later(GRACE_MINUTES + 1))).toEqual([]);
      expect(await overdueAutopilotDrafts(later(GRACE_MINUTES + 6))).toEqual([draftId]);
    });

    describe("GUARDRAIL: a Reply-To never unlocks autopilot (review B1)", () => {
      /** The customer's email, re-stored with a Reply-To (as sync now does). */
      const replyTo = (threadId: string, address: string | null) =>
        database
          .update(messages)
          .set({ replyToHeader: address === null ? null : { address } })
          .where(and(eq(messages.threadId, threadId), eq(messages.direction, "in")));

      it("From a known customer + Reply-To a stranger: refused (it used to check the sender)", async () => {
        const t = await conversation();
        await replyTo(t, "stranger@elsewhere.com");
        const draftId = await drafted(t);
        const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
        expect(d!.toAddress).toBe("stranger@elsewhere.com");
        expect(await considerAutopilot(draftId, NOW)).toBeNull();
      });

      it("a Reply-To the owner has written to: still refused, it waits for the owner", async () => {
        const t = await conversation({ from: "no-reply@crm.wix.com", known: false });
        await database.insert(messages).values({
          threadId: t,
          mailboxId,
          gmailMessageId: `${t}-wrote-dana`,
          direction: "out",
          fromAddress: "owner@shop.com",
          toAddresses: ["dana@customer.com"],
          bodyText: "Earlier job.",
          sentAt: new Date(NOW.getTime() - 20 * 86_400_000),
        });
        await replyTo(t, "dana@customer.com");
        const draftId = await drafted(t);
        expect(await considerAutopilot(draftId, NOW)).toBeNull();
      });

      it("a plain known sender is unchanged", async () => {
        const draftId = await drafted(await conversation());
        expect(await considerAutopilot(draftId, NOW)).toEqual(later(GRACE_MINUTES));
      });

      it("a countdown stands down when the email turns out to have a Reply-To, or was never checked", async () => {
        const t = await conversation();
        const draftId = await drafted(t);
        expect(await considerAutopilot(draftId, NOW)).toEqual(later(GRACE_MINUTES));
        // The stored draft now goes elsewhere than the sender (e.g. re-pointed).
        await database
          .update(drafts)
          .set({ toAddress: "stranger@elsewhere.com" })
          .where(eq(drafts.id, draftId));
        expect(await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)))).toMatchObject({
          status: "stood_down",
        });
        expect(writer.sent).toHaveLength(0);

        const t2 = await conversation();
        const d2 = await drafted(t2);
        await replyTo(t2, null); // a newer row stored by older code: never checked
        expect(await considerAutopilot(d2, NOW)).toBeNull();
        expect(
          guardrailReasons({
            category: "scheduling",
            needsOwner: false,
            kind: "reply",
            confidencePct: 95,
            flags: [],
            amountsInEmail: [],
            draftBody: "Hi",
            knownCustomer: true,
            purpose: null,
            replyToUnchecked: true,
            redirected: true,
          }),
        ).toEqual(
          expect.arrayContaining([
            "This reply goes to a different address than the sender's, so it waits for you.",
            "We couldn't check where this reply goes, so it waits for you.",
          ]),
        );
      });
    });
  });
});

// --- Plan #47 offer A: autopilot follows the plan that counts (§3.6) -----------------------

describe("autopilot follows the plan that counts (free referral months, any plan drop)", () => {
  const DAY = 86_400_000;
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;

  const lock = (over: Partial<Workspace>) =>
    accountLockReason(
      {
        status: "active",
        evaluationEndsAt: null,
        setupPaidVia: "stripe",
        plan: "solo",
        freePlan: null,
        freePlanUntil: null,
        ...over,
      },
      NOW,
    );

  it("layer 1 reads the free plan while it runs, and only while it runs", () => {
    expect(lock({})).toMatch(/Crew and Company/);
    expect(lock({ freePlan: "crew", freePlanUntil: new Date(NOW.getTime() + DAY) })).toBeNull();
    expect(lock({ freePlan: "crew", freePlanUntil: NOW })).toMatch(/Crew and Company/);
    expect(lock({ freePlan: "crew", freePlanUntil: null })).toMatch(/Crew and Company/);
    // A free month never unlocks what the account's status or payment locks.
    expect(
      lock({
        status: "setup_paid",
        freePlan: "crew",
        freePlanUntil: new Date(NOW.getTime() + DAY),
      }),
    ).toMatch(/setup call/);
  });

  async function setWs(values: Partial<typeof workspaces.$inferInsert>) {
    await database.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));
  }
  /** One category on autopilot and one reply counting down. */
  async function autopilotOn() {
    await database
      .insert(rules)
      .values({ workspaceId, category: "scheduling", mode: "autopilot", updatedAt: NOW });
    const [t] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: `t-${Math.random()}` })
      .returning();
    await database.insert(drafts).values({
      threadId: t!.id,
      mailboxId,
      gmailDraftId: `g-${t!.id}`,
      toAddress: "dana@customer.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      reason: "r",
      promptVersion: "draft.v1",
      autoSendAt: later(10),
    });
  }
  const state = async () => ({
    modes: (await database.select().from(rules)).map((r) => r.mode),
    countdowns: (await database.select().from(drafts)).filter((d) => d.autoSendAt).length,
    logged: (
      await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "autopilot_turned_off_plan"))
    ).map((l) => l.detail),
  });

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
    await setWs({ status: "active", plan: "crew", setupPaidVia: "stripe" });
  });

  it("a plan without autopilot switches every category back and stops countdowns, once", async () => {
    await autopilotOn();
    expect(await autopilotPlanEffects(workspaceId, NOW)).toBe(0); // Crew keeps it
    // A move down on Stripe's page writes the plan; the effects run after it.
    await setWs({ plan: "solo" });
    expect(await autopilotPlanEffects(workspaceId, NOW)).toBe(1);
    expect(await state()).toEqual({ modes: ["draft"], countdowns: 0, logged: [{ count: 1 }] });
    expect(await autopilotPlanEffects(workspaceId, NOW)).toBe(0);
    expect((await state()).logged).toHaveLength(1);
  });

  it("a running free Crew month keeps autopilot on; it goes off once the month is over", async () => {
    await setWs({ plan: "solo", freePlan: "crew", freePlanUntil: new Date(NOW.getTime() + DAY) });
    await autopilotOn();
    expect(await autopilotPlanEffects(workspaceId, NOW)).toBe(0);
    expect((await state()).modes).toEqual(["autopilot"]);
    expect(await autopilotPlanEffects(workspaceId, new Date(NOW.getTime() + DAY))).toBe(1);
    expect(await state()).toEqual({ modes: ["draft"], countdowns: 0, logged: [{ count: 1 }] });
  });

  it("the 15-minute invariant resets rules left on under a plan without autopilot", async () => {
    await autopilotOn();
    // Left behind by an older Stripe-page downgrade that never ran the effects.
    await setWs({ plan: "solo" });
    const { workspace: other } = await ensureUserAndWorkspace({ email: "crew@other.com" });
    await database
      .update(workspaces)
      .set({ status: "active", plan: "company", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, other.id));
    await database
      .insert(rules)
      .values({ workspaceId: other.id, category: "scheduling", mode: "autopilot" });

    expect(await enforcePlanAutopilot(NOW)).toBe(1);
    const modes = await database.select().from(rules);
    expect(modes.map((r) => [r.workspaceId === workspaceId, r.mode]).sort()).toEqual([
      [false, "autopilot"],
      [true, "draft"],
    ]);
    expect(await enforcePlanAutopilot(NOW)).toBe(0);
  });

  it("the admin's plan change runs the same effects, and logs what it switched off", async () => {
    await autopilotOn();
    await setWorkspacePlan(workspaceId, "solo", NOW);
    expect(await state()).toEqual({ modes: ["draft"], countdowns: 0, logged: [{ count: 1 }] });
    const changed = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "plan_changed"));
    expect(changed.map((l) => l.detail)).toEqual([{ by: "admin", from: "crew", to: "solo" }]);
  });

  it("the queue shows a countdown only while autopilot is open to the account", () => {
    const page = readFileSync("src/app/(app)/queue/page.tsx", "utf8");
    expect(page).toContain("const autopilotOpen = accountLockReason(workspace) === null;");
    expect(page).toContain("autoSendAt={i.autoSendAt && autopilotOpen ?");
  });
});
