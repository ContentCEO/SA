import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import {
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  FIRST_CONTACT_TASK,
  replyDraftSchema,
  type ModelReplyDraft,
} from "@/ai/prompts/draft.v7";
import { draftSchema } from "@/ai/prompts/draft.v6";
import { DRAFT_INSTRUCTIONS as ACTIVE_DRAFT_INSTRUCTIONS } from "@/ai/prompts/draft.v8";
import { OPENING_TWEAKS } from "@/ai/prompts/opening-tweaks.v1";
import { MAX_REVISIONS_PER_DRAFT } from "@/config/drafting";
import { OPENING_TWEAK_LABELS } from "@/config/tweaks";
import type { Database } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity } from "@/server/activity";
import { createDraftForThread, listQueue, reviseDraft } from "@/server/drafts";
import {
  isFirstContact,
  offersOtherWays,
  openingLine,
  questionCount,
  storedOpening,
} from "@/server/first-contact-rules";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-16T16:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const reply = (body: string, over: Partial<ModelReplyDraft> = {}) => ({
  body,
  reason: "New lead, deck repair. Thanked them and asked two questions.",
  flags: [],
  confidence: 0.9,
  used_facts: ["trade_questions"],
  opening: "details",
  ...over,
});
const WARM =
  "Hi Dana,\n\nThanks for reaching out about the deck. How many boards are soft? Is the railing attached to the house? Happy to come take a look.\n\nAlex";

describe("first replies: the rules (pure)", () => {
  const base = {
    followup: false,
    purpose: null,
    category: "quote_request",
    gasSmell: false,
    ownerWroteBefore: false,
    handledOffline: false,
  };
  it("an ordinary reply about a job, to someone the owner never wrote to", () => {
    expect(isFirstContact(base)).toBe(true);
    expect(isFirstContact({ ...base, category: "customer_question" })).toBe(true);
    expect(isFirstContact({ ...base, category: "scheduling" })).toBe(true);
    for (const category of ["complaint", "supplier_vendor", "invoice_payment", "noise", null])
      expect(isFirstContact({ ...base, category }), String(category)).toBe(false);
    expect(isFirstContact({ ...base, ownerWroteBefore: true })).toBe(false);
    expect(isFirstContact({ ...base, handledOffline: true })).toBe(false);
    expect(isFirstContact({ ...base, followup: true })).toBe(false);
    expect(isFirstContact({ ...base, purpose: "deposit" })).toBe(false);
    // A gas smell keeps its own safety-note flow, unchanged.
    expect(isFirstContact({ ...base, gasSmell: true })).toBe(false);
  });

  it("stores the model's shape on a first contact only", () => {
    expect(storedOpening(true, "urgent")).toBe("urgent");
    expect(storedOpening(true, undefined)).toBe("not_first");
    expect(storedOpening(false, "urgent")).toBeNull();
  });

  it("the card's line counts the questions in the text as it stands", () => {
    expect(questionCount("Where is it? When?? ok")).toBe(2);
    expect(questionCount(null)).toBe(0);
    expect(openingLine("details", "A? B?")).toBe(
      "First reply: asks 2 questions · they described the job",
    );
    expect(openingLine("urgent", "Best number to reach you?")).toBe(
      "First reply: asks 1 question · sounds urgent",
    );
    expect(openingLine("price_only", "Thanks!")).toBe(
      "First reply: asks no questions · they asked about price",
    );
    expect(openingLine("vague", "?")).toContain("they didn't say much yet");
    expect(openingLine("not_first", "A?")).toBeNull();
    expect(openingLine(null, "A?")).toBeNull();
  });

  it("'Other ways to reply': a first reply that can still be changed, never read-only", () => {
    expect(offersOtherWays({ opening: "details", revisionsLeft: 5, readOnly: false })).toBe(true);
    expect(offersOtherWays({ opening: "details", revisionsLeft: 0, readOnly: false })).toBe(false);
    expect(offersOtherWays({ opening: "details", revisionsLeft: 5, readOnly: true })).toBe(false);
    expect(offersOtherWays({ opening: "not_first", revisionsLeft: 5, readOnly: false })).toBe(
      false,
    );
    expect(offersOtherWays({ opening: null, revisionsLeft: 5, readOnly: false })).toBe(false);
  });

  it("the three chips, in plain words, match the prompt file", () => {
    expect(Object.values(OPENING_TWEAK_LABELS)).toEqual([
      "Ask a few questions",
      "Offer to come take a look",
      "Short and friendly",
    ]);
    for (const [k, v] of Object.entries(OPENING_TWEAKS))
      expect(OPENING_TWEAK_LABELS[k as keyof typeof OPENING_TWEAK_LABELS]).toBe(v.label);
    // None of the asks may invent a day, a time or a price.
    for (const v of Object.values(OPENING_TWEAKS)) expect(v.ask).toMatch(/No price|no price/i);
  });

  it("draft.v7 keeps draft.v6's rules and adds the first-contact section", () => {
    expect(DRAFT_PROMPT_VERSION).toBe("draft.v7");
    for (const rule of [
      "## Never invent",
      "## Gaps for the owner to fill in",
      "## The owner's price list",
      "## Dates and times",
      "## First contact",
      "never ask for anything they already told you",
      "Never promise a time",
    ])
      expect(DRAFT_INSTRUCTIONS).toContain(rule);
    expect(replyDraftSchema.parse({ ...reply("x"), opening: "bogus" }).opening).toBe("not_first");
    expect(replyDraftSchema.parse({ ...reply("x"), opening: undefined }).opening).toBe("not_first");
  });
});

describe("first replies: drafting (stand-in model)", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  let n = 0;
  const deps = () => ({ writerFor: () => writer, now: () => NOW });

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    await database
      .update(workspaces)
      .set({ status: "active", setupPaidVia: "stripe" })
      .where(eq(workspaces.id, workspaceId));
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    writer = new FakeWriter();
  });
  afterEach(() => setModelTransportForTests(undefined));

  /** A lead: one email from Dana, sorted as `category`. */
  async function lead(
    over: Partial<typeof threads.$inferInsert> = {},
    from = "dana@customer.example",
    box = mailboxId,
  ) {
    n += 1;
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId: box,
        gmailThreadId: `t-${n}`,
        inInbox: true,
        subject: "Deck",
        category: "quote_request",
        classifiedAt: hoursAgo(1),
        lastMessageAt: hoursAgo(1),
        ...over,
      })
      .returning();
    await email(t!.id, "in", hoursAgo(1), { from, box });
    return t!;
  }
  async function email(
    threadId: string,
    direction: "in" | "out",
    sentAt: Date,
    o: { from?: string; to?: string[]; subject?: string; box?: string } = {},
  ) {
    n += 1;
    await database.insert(messages).values({
      threadId,
      mailboxId: o.box ?? mailboxId,
      gmailMessageId: `m-${n}`,
      rfc822MessageId: `<m-${n}@x.example>`,
      direction,
      fromAddress: direction === "in" ? (o.from ?? "dana@customer.example") : "owner@shop.com",
      fromName: direction === "in" ? "Dana" : "Owner",
      toAddresses: o.to ?? (direction === "in" ? ["owner@shop.com"] : ["dana@customer.example"]),
      replyToHeader: direction === "in" ? {} : null,
      subject: o.subject ?? "Deck",
      bodyText:
        direction === "in"
          ? "Hi, a few deck boards are soft and the railing wobbles. 12 Elm St. Can you quote it?"
          : "Sure thing.",
      sentAt,
    });
  }
  const draftOf = async (threadId: string) =>
    (await database.select().from(drafts).where(eq(drafts.threadId, threadId)))[0];

  it("a new lead gets the first-contact task, the reply schema, and its shape stored", async () => {
    const t = await lead();
    const { transport, calls } = fakeTransport([reply(WARM, { opening: "details" })]);
    setModelTransportForTests(transport);
    const r = await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(r.status).toBe("created");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system[0]!.text).toBe(ACTIVE_DRAFT_INSTRUCTIONS);
    expect(calls[0]!.user).toContain(FIRST_CONTACT_TASK);
    expect(calls[0]!.schema).toBe(replyDraftSchema);
    const d = await draftOf(t.id);
    expect(d).toMatchObject({ opening: "details", promptVersion: "draft.v8", status: "pending" });
    // Nothing sent: a real Gmail draft that waits for the owner's tap.
    expect(writer.sent).toEqual([]);
    const [row] = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "draft_created"));
    expect(row!.detail).toMatchObject({ firstContact: true });
    // The card reads it.
    const q = await listQueue(workspaceId, NOW);
    expect(q.drafts[0]!.opening).toBe("details");
    expect(openingLine(q.drafts[0]!.opening, q.drafts[0]!.body)).toBe(
      "First reply: asks 2 questions · they described the job",
    );
  });

  it("not a first contact when the owner wrote to them before — another thread, another mailbox, or this one", async () => {
    // (1) An older thread with Dana, answered by the owner.
    const older = await lead({ category: "customer_question" });
    await email(older.id, "out", hoursAgo(300));
    const t1 = await lead();
    const one = fakeTransport([reply(WARM, { opening: "details" })]);
    setModelTransportForTests(one.transport);
    await createDraftForThread(t1.id, { trigger: "auto", ...deps() });
    expect(one.calls[0]!.user).not.toContain("FIRST CONTACT");
    // The model said "details" anyway: the code decides, so nothing is stored.
    expect((await draftOf(t1.id))!.opening).toBeNull();
  });

  it("the owner's other mailbox counts too", async () => {
    await database
      .update(workspaces)
      .set({ plan: "company" })
      .where(eq(workspaces.id, workspaceId));
    const [ws] = await database.select().from(workspaces);
    const other = (
      await saveConnectedMailbox(ws!, {
        email: "office@shop.com",
        refreshToken: "rt2",
        grantedScopes: [],
      })
    ).id;
    const old = await lead({}, "dana@customer.example", other);
    await email(old.id, "out", hoursAgo(500), { box: other });
    const t = await lead();
    const { transport, calls } = fakeTransport([reply(WARM)]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls[0]!.user).not.toContain("FIRST CONTACT");
  });

  it("an owner email on this conversation (to any address) or a reply sent from the app counts", async () => {
    const t = await lead();
    // The owner answered a form robot's address on this very thread (before Reply-To fixes).
    await email(t.id, "out", hoursAgo(0.9), { to: ["robot@forms.example"] });
    await email(t.id, "in", hoursAgo(0.5));
    const a = fakeTransport([reply(WARM)]);
    setModelTransportForTests(a.transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(a.calls[0]!.user).not.toContain("FIRST CONTACT");

    // A reply sent from the app that sync hasn't stored yet.
    const u = await lead({}, "sam@customer.example");
    await database.insert(drafts).values({
      threadId: u.id,
      mailboxId,
      toAddress: "sam@customer.example",
      subject: "Re",
      reason: "r",
      status: "sent",
      decidedAt: hoursAgo(200),
    });
    const v = await lead({}, "sam@customer.example");
    const b = fakeTransport([reply(WARM)]);
    setModelTransportForTests(b.transport);
    await createDraftForThread(v.id, { trigger: "auto", ...deps() });
    expect(b.calls[0]!.user).not.toContain("FIRST CONTACT");
  });

  it("an old reply to a website form's robot never makes the next form lead 'known'", async () => {
    const robot = "no-reply@forms.example";
    const old = await lead({}, robot);
    await email(old.id, "out", hoursAgo(400), { to: [robot] });
    const t = await lead({}, robot);
    await database
      .update(messages)
      .set({ replyToHeader: { address: "new.person@customer.example" } })
      .where(eq(messages.threadId, t.id));
    const { transport, calls } = fakeTransport([reply(WARM)]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls[0]!.user).toContain(FIRST_CONTACT_TASK);
    expect((await draftOf(t.id))!.toAddress).toBe("new.person@customer.example");
  });

  it("a forward to the crew isn't writing to the customer: still a first contact", async () => {
    const t = await lead();
    await email(t.id, "out", hoursAgo(0.8), { to: ["mike@shop.com"], subject: "Fwd: Deck" });
    await email(t.id, "in", hoursAgo(0.5));
    const { transport, calls } = fakeTransport([reply(WARM)]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls[0]!.user).toContain(FIRST_CONTACT_TASK);
  });

  it("'I called them' on this conversation: not a first contact", async () => {
    const t = await lead({ handledOfflineAt: hoursAgo(5) });
    await email(t.id, "in", hoursAgo(0.5));
    const { transport, calls } = fakeTransport([reply(WARM)]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls[0]!.user).not.toContain("FIRST CONTACT");
  });

  it("suppliers, invoices, complaints and the gas safety note never get it", async () => {
    for (const category of ["supplier_vendor", "invoice_payment"]) {
      const t = await lead({ category });
      const { transport, calls } = fakeTransport([reply(WARM)]);
      setModelTransportForTests(transport);
      await createDraftForThread(t.id, { trigger: "auto", ...deps() });
      expect(calls[0]!.user, category).not.toContain("FIRST CONTACT");
      expect((await draftOf(t.id))!.opening).toBeNull();
    }
    // A complaint is drafted only on the owner's tap — and gets no first-contact shape.
    const c = await lead({ category: "complaint", needsOwner: true });
    const cc = fakeTransport([reply(WARM)]);
    setModelTransportForTests(cc.transport);
    await createDraftForThread(c.id, { trigger: "owner", workspaceId, ...deps() });
    expect(cc.calls[0]!.user).not.toContain("FIRST CONTACT");
    // A gas smell: the job writes the fixed safety note (no model call), unchanged.
    const g = await lead({
      category: "customer_question",
      needsOwner: true,
      priority: "high",
      extracted: { gas_smell: true, urgency: "emergency" },
    });
    const gg = fakeTransport([]);
    setModelTransportForTests(gg.transport);
    await createDraftForThread(g.id, { trigger: "auto", ...deps() });
    expect(gg.calls).toHaveLength(0);
    expect(await draftOf(g.id)).toMatchObject({ purpose: "safety", opening: null });
  });

  it("an urgent lead needs the owner: no job draft; the owner's tap writes the urgent shape", async () => {
    const t = await lead({
      category: "customer_question",
      needsOwner: true,
      priority: "high",
      extracted: { urgency: "emergency" },
    });
    setModelTransportForTests(fakeTransport([]).transport);
    expect(await createDraftForThread(t.id, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "needs_owner",
    });
    const { transport, calls } = fakeTransport([
      reply(
        "Hi Dana,\n\nSo sorry — what's the best number to reach you, and the address?\n\nAlex",
        {
          opening: "urgent",
        },
      ),
    ]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "owner", workspaceId, ...deps() });
    expect(calls[0]!.user).toContain(FIRST_CONTACT_TASK);
    expect((await draftOf(t.id))!.opening).toBe("urgent");
  });

  it("every check still runs: an invented price gets one regenerate, then a flag", async () => {
    const t = await lead();
    const { transport, calls } = fakeTransport([
      reply("Hi Dana,\n\nThanks for reaching out! That's usually about $400.\n\nAlex"),
      reply("Hi Dana,\n\nThanks for reaching out! Probably $450 or so.\n\nAlex"),
    ]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls).toHaveLength(2);
    const d = await draftOf(t.id);
    expect(d!.flags.join(" ")).toContain("$450");
    expect(d!.confidence).toBeLessThan(90);
  });

  it("a nudge keeps its own prompt and output (no first-contact shape)", async () => {
    const t = await lead();
    await email(t.id, "out", hoursAgo(0.5));
    await database
      .update(threads)
      .set({ lastMessageAt: hoursAgo(0.5) })
      .where(eq(threads.id, t.id));
    const { transport, calls } = fakeTransport([reply("Hi Dana, just checking in.")]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "followup", ...deps() });
    expect(calls[0]!.schema).toBe(draftSchema);
    expect((await draftOf(t.id))!.opening).toBeNull();
  });

  describe("'Other ways to reply'", () => {
    async function firstReply(opening: ModelReplyDraft["opening"] = "details") {
      const t = await lead();
      setModelTransportForTests(fakeTransport([reply(WARM, { opening })]).transport);
      await createDraftForThread(t.id, { trigger: "auto", ...deps() });
      return (await draftOf(t.id))!;
    }

    it("re-drafts through the revise flow with a fixed ask; nothing is sent", async () => {
      const d = await firstReply();
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const { transport, calls } = fakeTransport([
        reply(
          "Hi Dana,\n\nThanks! I'd be glad to come take a look. What day works for you?\n\nAlex",
        ),
      ]);
      setModelTransportForTests(transport);
      writer.calls.length = 0;
      const r = await reviseDraft(workspaceId, d.id, { opening: "visit" }, deps());
      expect(r).toEqual({ status: "revised", flags: [] });
      expect(calls[0]!.system[0]!.text).toMatch(/^You revise a reply/);
      expect(calls[0]!.user).toContain(OPENING_TWEAKS.visit.ask);
      expect(
        info.mock.calls.some(
          ([, m]) =>
            (m as { promptVersion?: string })?.promptVersion === "revise.v2+opening-tweaks.v1",
        ),
      ).toBe(true);
      info.mockRestore();
      const after = (await draftOf(d.threadId))!;
      expect(after).toMatchObject({ status: "pending", revisions: 1, opening: "details" });
      expect(writer.calls).toEqual(["getDraft", "updateDraft"]);
      expect(writer.sent).toEqual([]);
      const [row] = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "draft_revised"));
      expect(row!.detail).toMatchObject({ via: "opening_visit" });
      expect(describeActivity(row!.action, row!.detail, null)).not.toBeNull();
    });

    it("GUARDRAIL: refused on a draft that isn't a first reply, before any model call", async () => {
      const older = await lead({ category: "customer_question" });
      await email(older.id, "out", hoursAgo(300));
      const t = await lead();
      setModelTransportForTests(fakeTransport([reply(WARM)]).transport);
      await createDraftForThread(t.id, { trigger: "auto", ...deps() });
      const d = (await draftOf(t.id))!;
      expect(d.opening).toBeNull();
      const { transport, calls } = fakeTransport([reply("x")]);
      setModelTransportForTests(transport);
      expect(await reviseDraft(workspaceId, d.id, { opening: "short" }, deps())).toEqual({
        status: "not_first_contact",
      });
      expect(calls).toHaveLength(0);
      // A first reply the model said wasn't one (not_first) gets no chips either.
      const e = await firstReply("not_first");
      expect(await reviseDraft(workspaceId, e.id, { opening: "short" }, deps())).toEqual({
        status: "not_first_contact",
      });
    });

    it("GUARDRAIL: the revise limits hold, and read-only accounts can't use it", async () => {
      const d = await firstReply();
      await database
        .update(drafts)
        .set({ revisions: MAX_REVISIONS_PER_DRAFT })
        .where(eq(drafts.id, d.id));
      expect(await reviseDraft(workspaceId, d.id, { opening: "questions" }, deps())).toEqual({
        status: "limit",
      });
      await database.update(drafts).set({ revisions: 0 }).where(eq(drafts.id, d.id));
      await database
        .update(workspaces)
        .set({ status: "evaluation_expired" })
        .where(eq(workspaces.id, workspaceId));
      await expect(
        reviseDraft(workspaceId, d.id, { opening: "questions" }, deps()),
      ).rejects.toBeInstanceOf(ReadOnlyError);
    });

    it("a chip's result is checked like any draft: an invented time is flagged", async () => {
      const d = await firstReply();
      setModelTransportForTests(
        fakeTransport([
          reply("Hi Dana,\n\nI can come by Tuesday at 3pm to take a look.\n\nAlex"),
          reply("Hi Dana,\n\nI can come by Tuesday at 3pm.\n\nAlex"),
        ]).transport,
      );
      await reviseDraft(workspaceId, d.id, { opening: "visit" }, deps());
      const after = (await draftOf(d.threadId))!;
      expect(after.flags.length).toBeGreaterThan(0);
    });
  });

  it("the stored shape is a key only", async () => {
    const t = await lead();
    setModelTransportForTests(fakeTransport([reply(WARM, { opening: "price_only" })]).transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [box] = await database.select().from(mailboxes);
    expect(box).toBeDefined();
    expect((await draftOf(t.id))!.opening).toBe("price_only");
  });
});
