import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelVoice } from "@/ai/prompts/voice.v1";
import type { Database } from "@/db";
import { eq } from "drizzle-orm";
import { mailboxes, messages, voiceProfiles } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { saveVoiceEdits, voiceEditInput } from "@/server/profile";
import {
  learnVoice,
  scrubExample,
  VOICE_STUCK_AFTER_MS,
  workspacesDueForVoiceRefresh,
  workspacesNeedingVoice,
} from "@/server/voice";
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

describe("scrubExample", () => {
  it("leaves ordinary sentences alone", () => {
    expect(scrubExample("I can swing by Tuesday around 8.")).toBe(
      "I can swing by Tuesday around 8.",
    );
  });
});
