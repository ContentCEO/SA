import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelVoice } from "@/ai/prompts/voice.v2";
import type { Database } from "@/db";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, messages, threads, voiceProfiles, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { saveVoiceEdits, voiceEditInput } from "@/server/profile";
import {
  learnVoice,
  resetVoiceRestarts,
  restartVoiceLearns,
  scrubExample,
  VOICE_STUCK_AFTER_MS,
  workspacesDueForVoiceRefresh,
  workspacesNeedingVoice,
} from "@/server/voice";
import { workspaceContext } from "@/server/drafts";
import { lastUpdateNote, voiceListLine } from "@/server/voice-rules";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";
import { fakeTransport } from "../support/fake-model";

const voice = (over: Partial<ModelVoice> = {}): ModelVoice => ({
  summary: "You write short, direct replies.",
  greeting_style: "Hey",
  signoff_style: "Thanks, Davi",
  avg_length_words: 42,
  formality: "casual",
  phrases_used: ["sounds good", "I'll swing by"],
  phrases_avoided: ["I hope this email finds you well"],
  examples: [
    "Hey [name], I can swing by Tuesday. Call me at 978-555-1212 or email dana@x.com.",
    "Sounds good — it'll be $450 for the panel swap at 12 Elm Street.",
    "a",
    "b",
    "c",
  ],
  ...over,
});

let database: Database;
let workspaceId: string;
let fake: FakeMailbox;
const deps = () => ({
  readerFor: () => fake.reader(),
  now: () => new Date("2026-09-28T12:00:00Z"),
});

function addSent(n: number) {
  for (let i = 0; i < n; i++) {
    fake.add({
      id: `s${i}`,
      threadId: `t${i}`,
      labelIds: ["SENT"],
      bodyText: `Hey Marco, I'll swing by Tuesday around 8. Thanks, Davi ${i}\n\nOn Mon, Bob wrote:\n> QUOTED-CUSTOMER-TEXT`,
    });
  }
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: [],
  });
  fake = new FakeMailbox();
});

describe("learning the owner's voice", () => {
  it("reads only sent mail, strips quoted text, and stores the profile — not the emails", async () => {
    addSent(8);
    fake.add({
      id: "inbound",
      threadId: "x",
      labelIds: ["INBOX"],
      bodyText: "INBOUND-CUSTOMER-TEXT please call",
    });
    const { transport, calls } = fakeTransport([voice()]);
    setModelTransportForTests(transport);

    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-sonnet-5");
    expect(calls[0]!.user).toContain("Here are 8 emails the owner sent");
    expect(calls[0]!.user).not.toContain("QUOTED-CUSTOMER-TEXT");
    expect(calls[0]!.user).not.toContain("INBOUND-CUSTOMER-TEXT");

    const [v] = await database.select().from(voiceProfiles);
    expect(v).toMatchObject({
      status: "ready",
      source: "learned",
      greetingStyle: "Hey",
      signoffStyle: "Thanks, Davi",
      learnedFromCount: 8,
    });
    expect(await database.select().from(messages)).toHaveLength(0); // sent mail never lands in the DB
  });

  it("scrubs phone numbers, emails, prices and addresses from examples", async () => {
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    await learnVoice(workspaceId, deps());
    const [v] = await database.select().from(voiceProfiles);
    expect(v!.examples[0]).toBe(
      "Hey [name], I can swing by Tuesday. Call me at [phone] or email [email].",
    );
    expect(v!.examples[1]).toBe("Sounds good — it'll be [price] for the panel swap at [address].");
  });

  it("scrubs the sign-off, greeting, phrases and summary too (Check 24 P4)", async () => {
    addSent(6);
    setModelTransportForTests(
      fakeTransport([
        voice({
          signoff_style: "Thanks, Mike 978-555-0100",
          greeting_style: "Hi dana at example dot com",
          phrases_used: ["it's about 1.2k", "see you at 45 maple st"],
          phrases_avoided: ["call 555-0142"],
          summary: "Quotes like twelve hundred and gives out dana@example.com.",
        }),
      ]).transport,
    );
    await learnVoice(workspaceId, deps());
    const v = await row();
    expect(v.signoffStyle).toBe("Thanks, Mike [phone]");
    expect(v.greetingStyle).toBe("Hi [email]");
    expect(v.phrasesUsed).toEqual(["it's about [price]", "see you at [address]"]);
    expect(v.phrasesAvoided).toEqual(["call [phone]"]);
    expect(v.summary).toBe("Quotes like [price] and gives out [email].");
  });

  it("says so plainly when there isn't enough sent mail, without calling the model", async () => {
    addSent(3);
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    expect(await learnVoice(workspaceId, deps())).toBe("not_enough_mail");
    expect(calls).toHaveLength(0);
    const [v] = await database.select().from(voiceProfiles);
    expect(v!.status).toBe("not_enough_mail");
  });

  it("never overwrites the owner's own edits unless they ask", async () => {
    addSent(6);
    await saveVoiceEdits(
      workspaceId,
      voiceEditInput.parse({
        greetingStyle: "Morning",
        signoffStyle: "– D",
        formality: "casual",
        avgLengthWords: "30",
        phrasesUsed: "",
        phrasesAvoided: "",
        summary: "",
      }),
    );
    const { transport, calls } = fakeTransport([voice()]);
    setModelTransportForTests(transport);
    expect(await learnVoice(workspaceId, deps())).toBe("skipped_edited");
    expect(calls).toHaveLength(0);
    expect(await workspacesDueForVoiceRefresh(new Date("2026-12-01"))).not.toContain(workspaceId);

    expect(await learnVoice(workspaceId, { ...deps(), force: true })).toBe("ready");
    const [v] = await database.select().from(voiceProfiles);
    expect(v).toMatchObject({ source: "learned", greetingStyle: "Hey" });
  });

  it("flags the mailbox if Google access is gone", async () => {
    fake.revoked = true;
    expect(await learnVoice(workspaceId, deps())).toBe("reconnect_needed");
    const [box] = await database.select().from(mailboxes);
    expect(box!.status).toBe("reconnect_needed");
  });

  it("a learn with no accepted ideas writes fresh samples (Check 24 P8)", async () => {
    await database.insert(voiceProfiles).values({ workspaceId, examplesStale: true });
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    await learnVoice(workspaceId, deps());
    expect((await row()).examplesStale).toBe(false);
    expect((await ctxVoice())!.examples).toHaveLength(5);
  });

  it("is due for a weekly refresh only after a week", async () => {
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    await learnVoice(workspaceId, deps());
    expect(await workspacesDueForVoiceRefresh(new Date("2026-10-01"))).not.toContain(workspaceId);
    expect(await workspacesDueForVoiceRefresh(new Date("2026-10-06"))).toContain(workspaceId);
  });
});

describe("restarting voice learning that never finished", () => {
  it("picks up a mailbox that's been read but whose voice was never learned, or died part-way", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    expect(await workspacesNeedingVoice(now)).toEqual([]); // first read not done yet
    await database.update(mailboxes).set({ backfillCompletedAt: now });
    expect(await workspacesNeedingVoice(now)).toEqual([workspaceId]);

    // Learning just started: leave it alone.
    await database
      .insert(voiceProfiles)
      .values({ workspaceId, status: "learning", updatedAt: now });
    expect(await workspacesNeedingVoice(now)).toEqual([]);
    // Still "learning" well past the limit: it died. Start it again.
    const later = new Date(now.getTime() + VOICE_STUCK_AFTER_MS + 60_000);
    expect(await workspacesNeedingVoice(later)).toEqual([workspaceId]);

    // Finished (or decided there wasn't enough mail): done.
    await database
      .update(voiceProfiles)
      .set({ status: "not_enough_mail" })
      .where(eq(voiceProfiles.workspaceId, workspaceId));
    expect(await workspacesNeedingVoice(later)).toEqual([]);
  });
});

const edits = (over: Record<string, string> = {}) =>
  voiceEditInput.parse({
    greetingStyle: "Morning",
    signoffStyle: "– Mike",
    formality: "casual",
    avgLengthWords: "30",
    phrasesUsed: "",
    phrasesAvoided: "",
    summary: "",
    ...over,
  });
const ctxVoice = async () =>
  (await workspaceContext(workspaceId, { businessName: "Shop", trade: "electrical" })).voice;
const row = async () =>
  (
    await database.select().from(voiceProfiles).where(eq(voiceProfiles.workspaceId, workspaceId))
  )[0]!;

describe("Check 24 P2: only the owner's own words go to the model", () => {
  it("drops Outlook-quoted and forwarded customer mail, keeps short replies, skips bare forwards", async () => {
    addSent(4);
    fake.add({
      id: "outlook",
      threadId: "o",
      labelIds: ["SENT"],
      bodyText:
        "OWNER-OUTLOOK I'll price it out.\n\n________________________________\nFrom: Dana <dana@example.com>\nSent: Tuesday\nTo: Mike\nSubject: RE: Deck\n\nCUSTOMER-OUTLOOK 45 Maple Street",
    });
    fake.add({ id: "short", threadId: "sh", labelIds: ["SENT"], bodyText: "Sounds good" });
    fake.add({
      id: "fwd",
      threadId: "f",
      labelIds: ["SENT"],
      bodyText:
        "FYI\n\n---------- Forwarded message ---------\nFrom: Dana <dana@example.com>\n\nCUSTOMER-FORWARD 978-555-0177",
    });
    const { transport, calls } = fakeTransport([voice()]);
    setModelTransportForTests(transport);
    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    const user = calls[0]!.user;
    expect(user).toContain("Here are 6 emails the owner sent");
    expect(user).toContain("OWNER-OUTLOOK");
    expect(user).toContain("Sounds good");
    expect(user).not.toContain("CUSTOMER-");
    expect(user).not.toContain("45 Maple Street");
    expect(user).not.toContain("978-555-0177");
  });
});

describe("Check 24 P3: replies the app wrote aren't learned as the owner's", () => {
  it("skips replies sent unchanged from the app, keeps ones the owner edited", async () => {
    addSent(6);
    fake.add({ id: "app-sent", threadId: "a", labelIds: ["SENT"], bodyText: "DRAFTER-WORDS hi" });
    fake.add({ id: "edited", threadId: "e", labelIds: ["SENT"], bodyText: "OWNER-EDIT words" });
    const [box] = await database.select().from(mailboxes);
    const [thread] = await database
      .insert(threads)
      .values({ mailboxId: box!.id, gmailThreadId: "a" })
      .returning();
    const draft = { threadId: thread!.id, mailboxId: box!.id, toAddress: "x@example.com" };
    await database.insert(drafts).values([
      { ...draft, subject: "Re", reason: "r", status: "sent", sentGmailMessageId: "app-sent" },
      {
        ...draft,
        subject: "Re",
        reason: "r",
        status: "edited_and_sent",
        sentGmailMessageId: "edited",
      },
    ]);
    const { transport, calls } = fakeTransport([voice()]);
    setModelTransportForTests(transport);
    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    expect(calls[0]!.user).not.toContain("DRAFTER-WORDS");
    expect(calls[0]!.user).toContain("OWNER-EDIT");
  });

  it("too few left once the app's own replies are dropped counts as not enough mail", async () => {
    await saveVoiceEdits(workspaceId, edits());
    addSent(5);
    const [box] = await database.select().from(mailboxes);
    const [thread] = await database
      .insert(threads)
      .values({ mailboxId: box!.id, gmailThreadId: "a" })
      .returning();
    await database.insert(drafts).values({
      threadId: thread!.id,
      mailboxId: box!.id,
      toAddress: "x@example.com",
      subject: "Re",
      reason: "r",
      status: "sent",
      sentGmailMessageId: "s0",
    });
    setModelTransportForTests(fakeTransport([]).transport);
    expect(await learnVoice(workspaceId, { ...deps(), force: true })).toBe("not_enough_mail");
    expect(await ctxVoice()).toMatchObject({ signoffStyle: "– Mike" });
  });
});

describe("Check 24 P6: the right inbox when a shop has more than one", () => {
  const second = async (email: string) => {
    const [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    await database.update(workspaces).set({ plan: "company" }).where(eq(workspaces.id, ws!.id));
    return saveConnectedMailbox(
      { id: workspaceId, plan: "company", freePlan: null, freePlanUntil: null },
      {
        email,
        refreshToken: "rt2",
        grantedScopes: [],
      },
    );
  };
  const readerBy = (byEmail: Record<string, FakeMailbox>) => ({
    ...deps(),
    readerFor: (m: { email: string }) => byEmail[m.email]!.reader(),
  });

  it("learns from the second inbox when the first lost access", async () => {
    const info = await second("info@shop.com");
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.email, "owner@shop.com"));
    const other = new FakeMailbox();
    for (let i = 0; i < 6; i++)
      other.add({ id: `i${i}`, threadId: `ti${i}`, labelIds: ["SENT"], bodyText: `INFO-BOX ${i}` });
    const { transport, calls } = fakeTransport([voice()]);
    setModelTransportForTests(transport);
    expect(await learnVoice(workspaceId, readerBy({ "info@shop.com": other }))).toBe("ready");
    expect(calls[0]!.user).toContain("INFO-BOX");
    expect((await row()).learnedFromMailboxId).toBe(info.id);
  });

  it("prefers the owner's own address over info@ when both are on", async () => {
    // info@ added first, so it's the older row; the owner's address still wins.
    await database.delete(mailboxes);
    await second("info@shop.com");
    await saveConnectedMailbox(
      { id: workspaceId, plan: "company", freePlan: null, freePlanUntil: null },
      {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      },
    );
    const info = new FakeMailbox();
    for (let i = 0; i < 6; i++)
      info.add({ id: `i${i}`, threadId: `ti${i}`, labelIds: ["SENT"], bodyText: `INFO-BOX ${i}` });
    addSent(6);
    const { transport, calls } = fakeTransport([voice()]);
    setModelTransportForTests(transport);
    expect(
      await learnVoice(workspaceId, readerBy({ "info@shop.com": info, "owner@shop.com": fake })),
    ).toBe("ready");
    expect(calls[0]!.user).not.toContain("INFO-BOX");
    expect(calls[0]!.user).toContain("Hey Marco");
  });

  it("isn't due again after a successful learn", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    await database.update(mailboxes).set({ backfillCompletedAt: now });
    expect(await workspacesNeedingVoice(now)).toEqual([workspaceId]);
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    expect(await workspacesNeedingVoice(new Date(now.getTime() + 86_400_000))).toEqual([]);
  });
});

describe("Check 24 P1: a learn that doesn't finish keeps the stored voice in drafts", () => {
  it("an edited voice survives a forced re-learn that finds too little mail", async () => {
    await saveVoiceEdits(workspaceId, edits());
    addSent(3);
    setModelTransportForTests(fakeTransport([]).transport);
    expect(await learnVoice(workspaceId, { ...deps(), force: true })).toBe("not_enough_mail");
    expect(await row()).toMatchObject({
      status: "ready",
      source: "edited",
      lastAttempt: "not_enough_mail",
      signoffStyle: "– Mike",
    });
    expect(await ctxVoice()).toMatchObject({ greetingStyle: "Morning", signoffStyle: "– Mike" });
  });

  it("an edited voice survives a forced re-learn that hits lost Google access, and the reconnect", async () => {
    await saveVoiceEdits(workspaceId, edits());
    fake.revoked = true;
    expect(await learnVoice(workspaceId, { ...deps(), force: true })).toBe("reconnect_needed");
    expect(await row()).toMatchObject({ status: "ready", lastAttempt: "reconnect_needed" });
    expect(await ctxVoice()).toMatchObject({ signoffStyle: "– Mike" });
    // Reconnected: the backfill asks for a normal learn, which leaves the edits alone.
    fake.revoked = false;
    await database.update(mailboxes).set({ status: "active" });
    expect(await learnVoice(workspaceId, deps())).toBe("skipped_edited");
    expect(await ctxVoice()).toMatchObject({ greetingStyle: "Morning", signoffStyle: "– Mike" });
  });

  it("a learned voice survives a weekly refresh whose model output is unusable twice", async () => {
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    setModelTransportForTests(fakeTransport([null, null]).transport);
    expect(
      await learnVoice(workspaceId, { ...deps(), now: () => new Date("2026-10-05T12:00:00Z") }),
    ).toBe("failed");
    expect(await row()).toMatchObject({ status: "ready", lastAttempt: "failed" });
    expect(await ctxVoice()).toMatchObject({ greetingStyle: "Hey", signoffStyle: "Thanks, Davi" });
  });

  it("drafts written while a refresh is running still get the stored voice", async () => {
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    await learnVoice(workspaceId, deps());
    let during: Awaited<ReturnType<typeof ctxVoice>> | undefined;
    let statusDuring: string | undefined;
    const { transport } = fakeTransport([voice({ greeting_style: "Hi" })]);
    setModelTransportForTests(async (req) => {
      during = await ctxVoice();
      statusDuring = (await row()).lastAttempt ?? undefined;
      return transport(req);
    });
    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    expect(statusDuring).toBe("learning");
    expect(during).toMatchObject({ greetingStyle: "Hey", signoffStyle: "Thanks, Davi" });
    expect(await ctxVoice()).toMatchObject({ greetingStyle: "Hi" });
  });

  it("a first-ever learn that fails still gives drafts no voice", async () => {
    addSent(6);
    setModelTransportForTests(fakeTransport([null, null]).transport);
    expect(await learnVoice(workspaceId, deps())).toBe("failed");
    expect(await row()).toMatchObject({ status: "failed", lastAttempt: "failed" });
    expect(await ctxVoice()).toBeNull();
  });

  it("the screens say the last update didn't finish instead of 'Not learned yet'", () => {
    const v = {
      status: "ready",
      source: "learned",
      summary: null,
      greetingStyle: "Hey",
      signoffStyle: null,
      examples: [],
      lastAttempt: "failed",
      lastAttemptAt: new Date("2026-10-13T15:00:00Z"),
      updatedAt: new Date("2026-10-13T15:00:00Z"),
    };
    expect(lastUpdateNote(v, "America/New_York")).toBe(
      "The last update didn't finish (Oct 13). We're still using this voice.",
    );
    expect(voiceListLine(v)).toBe("Learned from your sent mail");
    expect(voiceListLine({ ...v, greetingStyle: null, status: "failed" })).toBe(
      "Not learned yet: we'll try again soon",
    );
    expect(
      voiceListLine({ ...v, greetingStyle: null, status: "not_enough_mail", lastAttempt: null }),
    ).toBe("Not learned yet: not enough sent mail");
    expect(voiceListLine(null)).toBe("Not learned yet");
    expect(lastUpdateNote({ ...v, lastAttempt: "ready" }, "America/New_York")).toBeNull();
  });
});

describe("Check 29 P2: a learn that keeps dying is restarted at most twice", () => {
  const t0 = new Date("2026-09-28T12:00:00Z");
  const later = (n: number) => new Date(t0.getTime() + n * (VOICE_STUCK_AFTER_MS + 60_000));
  const stuck = async (restartCount: number) => {
    await database.update(mailboxes).set({ backfillCompletedAt: t0 });
    await database
      .insert(voiceProfiles)
      .values({
        workspaceId,
        status: "learning",
        lastAttempt: "learning",
        lastAttemptAt: t0,
        updatedAt: t0,
        restartCount,
      })
      .onConflictDoUpdate({
        target: voiceProfiles.workspaceId,
        set: { status: "learning", lastAttempt: "learning", lastAttemptAt: t0, restartCount },
      });
  };

  it("restarts a stuck learn once and counts it", async () => {
    await stuck(0);
    const send = vi.fn(async () => "sent" as const);
    expect(await restartVoiceLearns(later(1), { send })).toEqual([workspaceId]);
    expect((await row()).restartCount).toBe(1);
    // Counted and re-armed: not restarted again by the very next run.
    expect(await restartVoiceLearns(later(1), { send })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("gives up after two restarts: status failed and one email to Davi", async () => {
    process.env.ADMIN_EMAIL = "davi@example.com";
    await stuck(2);
    expect(await workspacesNeedingVoice(later(1))).toEqual([]);
    const sent: { to: string; subject: string; text: string }[] = [];
    const send = vi.fn(async (e: { to: string; subject: string; text: string }) => {
      sent.push(e);
      return "sent" as const;
    });
    expect(await restartVoiceLearns(later(1), { send })).toEqual([]);
    expect(await row()).toMatchObject({ status: "failed", lastAttempt: "failed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("davi@example.com");
    expect(sent[0]!.text).toContain("Voice learning failed twice for this account");
    // Stuck again later the same day: still no restart and no second email.
    await stuck(2);
    expect(await restartVoiceLearns(later(2), { send })).toEqual([]);
    expect(sent).toHaveLength(1);
    delete process.env.ADMIN_EMAIL;
  });

  it("a successful learn and the owner's re-learn both reset the count", async () => {
    await stuck(2);
    addSent(6);
    setModelTransportForTests(fakeTransport([voice()]).transport);
    expect(await learnVoice(workspaceId, deps())).toBe("ready");
    expect((await row()).restartCount).toBe(0);
    await database.update(voiceProfiles).set({ restartCount: 2 });
    await resetVoiceRestarts(workspaceId);
    expect((await row()).restartCount).toBe(0);
  });

  it("a restarted forced re-learn of an edited voice closes the attempt instead of looping", async () => {
    await saveVoiceEdits(workspaceId, edits());
    await database
      .update(voiceProfiles)
      .set({ lastAttempt: "learning", lastAttemptAt: t0, restartCount: 1 });
    expect(await learnVoice(workspaceId, deps())).toBe("skipped_edited");
    expect(await row()).toMatchObject({ status: "ready", lastAttempt: "failed" });
    expect(await workspacesNeedingVoice(later(1))).toEqual([]);
  });

  it("a thrown error in the model call leaves status failed, not learning", async () => {
    addSent(6);
    setModelTransportForTests(async () => {
      throw new Error("boom");
    });
    await expect(learnVoice(workspaceId, deps())).rejects.toThrow();
    expect(await row()).toMatchObject({ status: "failed", lastAttempt: "failed" });
  });
});

describe("Check 24 P12: a failed first learn is retried the same day", () => {
  const t0 = new Date("2026-09-28T12:00:00Z");
  const failedAt = async (at: Date, over: Partial<typeof voiceProfiles.$inferInsert> = {}) => {
    await database.update(mailboxes).set({ backfillCompletedAt: t0 });
    await database.insert(voiceProfiles).values({
      workspaceId,
      status: "failed",
      lastAttempt: "failed",
      lastAttemptAt: at,
      updatedAt: at,
      ...over,
    });
  };

  it("a failed row 2 hours old is due; 30 minutes old is not", async () => {
    await failedAt(new Date(t0.getTime() - 2 * 3_600_000));
    expect(await workspacesNeedingVoice(t0)).toEqual([workspaceId]);
    await database
      .update(voiceProfiles)
      .set({ lastAttemptAt: new Date(t0.getTime() - 30 * 60_000) });
    expect(await workspacesNeedingVoice(t0)).toEqual([]);
  });

  it("the AI cap counts too, but a stored voice or the gave-up mark doesn't retry", async () => {
    await failedAt(new Date(t0.getTime() - 2 * 3_600_000), { lastAttempt: "capped" });
    expect(await workspacesNeedingVoice(t0)).toEqual([workspaceId]);
    await database.update(voiceProfiles).set({ restartCount: 2 });
    expect(await workspacesNeedingVoice(t0)).toEqual([]);
    await database.update(voiceProfiles).set({ restartCount: 0, greetingStyle: "Hey" });
    expect(await workspacesNeedingVoice(t0)).toEqual([]);
  });

  it("three tries a day, then not again until tomorrow", async () => {
    await failedAt(new Date(t0.getTime() - 2 * 3_600_000));
    let now = t0;
    for (let i = 1; i <= 3; i++) {
      expect(await restartVoiceLearns(now)).toEqual([workspaceId]);
      expect((await row()).retriesThatDay).toBe(i);
      // The try fails again; an hour and a bit later it's due once more.
      now = new Date(now.getTime() + 61 * 60_000);
    }
    expect(await workspacesNeedingVoice(now)).toEqual([]); // fourth try in a day
    expect(await restartVoiceLearns(now)).toEqual([]);
    const tomorrow = new Date("2026-09-29T09:00:00Z");
    expect(await restartVoiceLearns(tomorrow)).toEqual([workspaceId]);
    expect((await row()).retriesThatDay).toBe(1);
  });
});

describe("scrubExample", () => {
  it("leaves ordinary sentences alone", () => {
    expect(scrubExample("I can swing by Tuesday around 8.")).toBe(
      "I can swing by Tuesday around 8.",
    );
  });
});
