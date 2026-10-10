import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import type { ModelDraft } from "@/ai/prompts/draft.v4";
import type { Database } from "@/db";
import { businessProfiles, drafts, messages, seasonalNotes, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  addNeverSay,
  cleanNeverSay,
  NEVER_SAY_MAX,
  NeverSayError,
  saveNeverSay,
} from "@/server/never-say";
import {
  activeNotes,
  addSeasonalNote,
  MAX_ACTIVE_NOTES,
  purgeExpiredNotes,
  SeasonalNoteError,
} from "@/server/seasonal-notes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

// Noon Eastern on Oct 10.
const NOW = new Date("2026-10-10T16:00:00Z");
const draft = (body: string): ModelDraft => ({
  body,
  reason: "Reply.",
  flags: [],
  confidence: 0.95,
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
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  writer = new FakeWriter();
});

async function thread(g = "t1") {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: g,
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
    gmailMessageId: `${g}-m1`,
    rfc822MessageId: `<${g}-m1@x.com>`,
    direction: "in",
    fromAddress: "dana@x.com",
    fromName: "Dana",
    subject: "Deck",
    bodyText: "Can you quote a deck repair?",
    sentAt: new Date(NOW.getTime() - 3600_000),
  });
  return t!;
}

describe("never-say list (#23)", () => {
  it("is cleaned: trimmed, de-duped ignoring case, too-short/long dropped, capped", () => {
    expect(
      cleanNeverSay(["  No worries ", "no worries", "x", "Per my last email", "a".repeat(200)]),
    ).toEqual(["No worries", "Per my last email"]);
    expect(cleanNeverSay(Array.from({ length: 80 }, (_, i) => `phrase ${i}`))).toHaveLength(
      NEVER_SAY_MAX,
    );
  });

  it("the check flags a listed phrase in any case", () => {
    const r = checkDraft("Hi Dana, no WORRIES at all!", {
      sourceText: "",
      doNotPromise: [],
      phrasesAvoided: [],
      neverSay: ["No worries"],
    });
    expect(r.hits).toContain("never_say");
    expect(r.flags[0]).toContain("never-say list");
    expect(r.confidenceCap).toBeLessThanOrEqual(0.2);
  });

  it("adding from the editor: needs a selection, de-dupes", async () => {
    await expect(addNeverSay(workspaceId, " ")).rejects.toBeInstanceOf(NeverSayError);
    await addNeverSay(workspaceId, "no worries");
    await addNeverSay(workspaceId, "No Worries");
    const [p] = await database.select().from(businessProfiles);
    expect(p!.neverSay).toEqual(["no worries"]);
  });

  it("a banned phrase is rewritten once; the clean retry is what reaches the queue", async () => {
    await saveNeverSay(workspaceId, "No worries");
    const t = await thread();
    const { transport, calls } = fakeTransport([
      draft("Hi Dana,\n\nNo worries, what's the address?\n\nThanks"),
      draft("Hi Dana,\n\nHappy to help — what's the address?\n\nThanks"),
    ]);
    setModelTransportForTests(transport);
    expect((await createDraftForThread(t.id, { trigger: "auto", ...deps() })).status).toBe(
      "created",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system[1]!.text).toContain('Never say: "No worries"');
    expect(calls[1]!.user).toContain("never-say list");
    const [d] = await database.select().from(drafts);
    expect(d!.body).not.toMatch(/no worries/i);
    expect(d!.flags).toEqual([]);
  });

  it("if the retry still says it, the draft is flagged — never unflagged in the queue", async () => {
    await saveNeverSay(workspaceId, "No worries");
    const t = await thread();
    const { transport, calls } = fakeTransport([
      draft("No worries, what's the address?"),
      draft("No worries at all — address?"),
    ]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    expect(calls).toHaveLength(2); // only one retry
    const [d] = await database.select().from(drafts);
    expect(d!.flags.join(" ")).toContain("never-say list");
    expect(d!.confidence).toBeLessThanOrEqual(20);
  });
});

describe("seasonal notes (#25)", () => {
  it("only active notes reach the drafting prompt; their dates aren't flagged", async () => {
    await database.insert(seasonalNotes).values([
      { workspaceId, text: "Booked through November", endsOn: "2026-11-30" },
      { workspaceId, text: "On vacation Oct 1–5", endsOn: "2026-10-05" }, // expired
      { workspaceId, text: "Ends today", endsOn: "2026-10-10" },
    ]);
    expect((await activeNotes(workspaceId, NOW)).map((n) => n.text)).toEqual([
      "Ends today",
      "Booked through November",
    ]);
    const t = await thread();
    const { transport, calls } = fakeTransport([
      draft(
        "Hi Dana,\n\nWe're booked through November, but happy to get you on the list.\n\nThanks",
      ),
    ]);
    setModelTransportForTests(transport);
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const block = calls[0]!.system[1]!.text;
    expect(block).toContain('"Booked through November" (until 2026-11-30)');
    expect(block).not.toContain("vacation");
    const [d] = await database.select().from(drafts);
    expect(d!.flags).toEqual([]);
  });

  it("max five active, no past dates, nothing beyond a year", async () => {
    await expect(
      addSeasonalNote(workspaceId, { text: "Old", endsOn: "2026-10-09" }, NOW),
    ).rejects.toMatchObject({ code: "past" });
    await expect(
      addSeasonalNote(workspaceId, { text: "Far", endsOn: "2028-01-01" }, NOW),
    ).rejects.toMatchObject({ code: "too_far" });
    for (let i = 0; i < MAX_ACTIVE_NOTES; i++) {
      await addSeasonalNote(workspaceId, { text: `Note ${i}`, endsOn: "2026-12-01" }, NOW);
    }
    await expect(
      addSeasonalNote(workspaceId, { text: "Sixth", endsOn: "2026-12-01" }, NOW),
    ).rejects.toBeInstanceOf(SeasonalNoteError);
  });

  it("expired notes are cleaned up", async () => {
    await database.insert(seasonalNotes).values([
      { workspaceId, text: "Old", endsOn: "2026-09-01" },
      { workspaceId, text: "Current", endsOn: "2026-12-01" },
    ]);
    await purgeExpiredNotes(NOW);
    const rows = await database
      .select()
      .from(seasonalNotes)
      .where(eq(seasonalNotes.workspaceId, workspaceId));
    expect(rows.map((r) => r.text)).toEqual(["Current"]);
  });
});
