import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import { fillGap, findGaps, hasUnfilledGap } from "@/ai/gaps";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import { confidenceLabel } from "@/config/drafting";
import type { Database } from "@/db";
import { drafts, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { guardrailReasons } from "@/server/autopilot";
import { createDraftForThread, listQueue, sendDraft } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const ctx = (sourceText = "") => ({ sourceText, doNotPromise: [], phrasesAvoided: [] });

describe("#43 checks in code, one rule at a time", () => {
  it("dollar amounts, in any form, unless they're in the thread or profile", () => {
    for (const body of [
      "It's $450.",
      "About 450 dollars.",
      "450 bucks, cash.",
      "$1,450.00 all in",
    ]) {
      const r = checkDraft(body, ctx());
      expect(r.hits, body).toContain("money");
      expect(r.flags[0]).toMatch(/\$[\d,]+/);
    }
    expect(checkDraft("It's $450.", ctx("they quoted $450")).hits).not.toContain("money");
    expect(checkDraft("$1,450 total", ctx("Price list: $1450")).hits).not.toContain("money");
  });

  it("days, dates and times the customer didn't bring up", () => {
    for (const body of [
      "See you Thursday.",
      "How about 8am?",
      "Free on 10/14.",
      "Booked for Oct 14th.",
    ]) {
      expect(checkDraft(body, ctx()).hits, body).toContain("when");
    }
    expect(checkDraft("Thursday works.", ctx("Can you do Thursday?")).hits).toEqual([]);
  });

  it("guarantee / warranty / promise words the customer and profile never used", () => {
    for (const body of [
      "We guarantee it won't leak.",
      "Comes with a warranty.",
      "I promise it'll be done.",
    ]) {
      const r = checkDraft(body, ctx());
      expect(r.hits, body).toContain("commitment");
      expect(r.confidenceCap).toBeLessThanOrEqual(0.4);
    }
    expect(
      checkDraft("Yes, it has a warranty.", ctx("Does it come with a warranty?")).hits,
    ).toEqual([]);
  });

  it("never-promise and never-say lists", () => {
    const r = checkDraft("We offer same-day service, no worries.", {
      ...ctx(),
      doNotPromise: ["Same-day service"],
      neverSay: ["no worries"],
    });
    expect(r.hits).toEqual(expect.arrayContaining(["never_promise", "never_say"]));
  });

  it("placeholders aren't facts and don't trip the checks", () => {
    expect(
      checkDraft("The swap is {{price}} and I can come {{date}} at {{time}}.", ctx()).hits,
    ).toEqual([]);
  });
});

describe("#2 gaps", () => {
  it("finds, labels and fills typed placeholders", () => {
    const body = "It's {{price}}, we can start {{date}}. Address: {{custom: job address}}.";
    expect(findGaps(body).map((g) => [g.kind, g.label])).toEqual([
      ["price", "price"],
      ["date", "date"],
      ["custom", "job address"],
    ]);
    const filled = fillGap(fillGap(fillGap(body, 2, "12 Elm St"), 1, "Monday"), 0, "$450");
    expect(filled).toBe("It's $450, we can start Monday. Address: 12 Elm St.");
    expect(hasUnfilledGap(filled)).toBe(false);
    expect(hasUnfilledGap("half-typed {{pri")).toBe(true);
  });
});

describe("#8 confidence in words", () => {
  it("maps confidence, flags and gaps to three labels; flags never read Ready", () => {
    expect(confidenceLabel({ confidencePct: 92, flags: 0, gaps: 0 })).toBe("ready");
    expect(confidenceLabel({ confidencePct: 92, flags: 1, gaps: 0 })).toBe("check_details");
    expect(confidenceLabel({ confidencePct: 92, flags: 0, gaps: 2 })).toBe("check_details");
    expect(confidenceLabel({ confidencePct: 65, flags: 0, gaps: 0 })).toBe("check_details");
    expect(confidenceLabel({ confidencePct: 30, flags: 3, gaps: 0 })).toBe("check_everything");
    expect(confidenceLabel({ confidencePct: null, flags: 0, gaps: 0 })).toBe("check_everything");
  });
});

describe("in the pipeline", () => {
  const NOW = new Date("2026-10-10T16:00:00Z");
  const draft = (body: string, over: Partial<ModelDraft> = {}): ModelDraft => ({
    body,
    reason: "Quote request. Asked for the address.",
    flags: [],
    confidence: 0.95,
    used_facts: [],
    ...over,
  });
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
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

  async function thread() {
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "t1",
        inInbox: true,
        subject: "Deck",
        category: "quote_request",
        classifiedAt: NOW,
        lastMessageAt: NOW,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: "m1",
      rfc822MessageId: "<m1@x.com>",
      direction: "in",
      fromAddress: "dana@x.com",
      fromName: "Dana",
      subject: "Deck",
      bodyText: "Can you quote a deck repair?",
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    return t!;
  }

  it("an invented price is rewritten once; the clean retry reaches the queue with its facts", async () => {
    const t = await thread();
    const { transport, calls } = fakeTransport([
      draft("Hi Dana, a deck repair is $1,200."),
      draft("Hi Dana, it's {{price}} once I see it — what's the address?", {
        used_facts: ["trade_questions", "voice_greeting"],
      }),
    ]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("$1,200");
    const { drafts: queue } = await listQueue(workspaceId);
    expect(queue[0]!.body).toContain("{{price}}");
    expect(queue[0]!.usedFacts).toEqual(["trade_questions", "voice_greeting"]);
    expect(queue[0]!.flags).toEqual([]);
  });

  it("if the retry still invents a date, it's flagged with the exact text", async () => {
    const t = await thread();
    setModelTransportForTests(
      fakeTransport([draft("I can come Thursday."), draft("I can come Friday at 8am.")]).transport,
    );
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    expect(d!.flags.join(" ")).toMatch(/friday.*8am|8am.*friday/i);
    expect(d!.confidence).toBeLessThanOrEqual(50);
  });

  it("the server refuses to send a reply with an unfilled gap — no Gmail call at all", async () => {
    const t = await thread();
    setModelTransportForTests(fakeTransport([draft("It's {{price}}. Address?")]).transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    writer.calls.length = 0;
    expect(await sendDraft(workspaceId, d!.id, deps())).toEqual({ status: "gaps_unfilled" });
    expect(
      await sendDraft(workspaceId, d!.id, { ...deps(), editedBody: "It's {{price}}, roughly." }),
    ).toEqual({ status: "gaps_unfilled" });
    expect(writer.calls).toEqual([]);

    const r = await sendDraft(workspaceId, d!.id, { ...deps(), editedBody: "It's $450. Address?" });
    expect(r.status).toBe("sent");
  });

  it("autopilot never sends a draft with gaps", () => {
    expect(
      guardrailReasons({
        category: "scheduling",
        needsOwner: false,
        kind: "reply",
        confidencePct: 95,
        flags: [],
        amountsInEmail: [],
        draftBody: "Works for me — see you {{date}}.",
        knownCustomer: true,
      }),
    ).toContain("Has gaps for you to fill in.");
  });
});
