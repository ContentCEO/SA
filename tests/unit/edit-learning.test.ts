import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import {
  drafts,
  editSignals,
  threads,
  voiceProfiles,
  voiceSuggestions,
  workspaces,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  captureEditSignals,
  decideSuggestion,
  openSuggestions,
  proposeVoiceUpdates,
} from "@/server/edit-learning";
import { editShape, proposeSuggestions, type EditSignal } from "@/server/edit-learning-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";

const NOW = new Date("2026-10-12T12:00:00Z");
const DRAFTED =
  "Hi Dana,\nThanks so much for reaching out about the deck. I'd be glad to help. What's the address, and roughly how big is it?\nThanks,\nSam";
const SENT = "Hi Dana,\nWhat's the address, and roughly how big is it?\nSam";

describe("#21 learn from edits", () => {
  describe("rules", () => {
    it("what an edit did, as counts and yes/no", () => {
      expect(editShape(DRAFTED, SENT)).toEqual({
        wordsBefore: 27,
        wordsAfter: 12,
        openingChanged: false,
        signoffChanged: true,
        firstSentenceCut: true,
        sentencesRemoved: 3,
        sentencesAdded: 0,
      });
    });

    const sig = (over: Partial<EditSignal> = {}): EditSignal => ({
      wordsBefore: 100,
      wordsAfter: 100,
      openingChanged: false,
      signoffChanged: false,
      firstSentenceCut: false,
      sentencesRemoved: 0,
      sentencesAdded: 0,
      toneShift: "none",
      ...over,
    });

    it("needs a habit: five edits, most of them the same way", () => {
      expect(proposeSuggestions(Array(4).fill(sig({ wordsAfter: 50 })))).toEqual([]);
      const shorter = proposeSuggestions(Array(5).fill(sig({ wordsAfter: 52 })));
      expect(shorter).toEqual([expect.objectContaining({ kind: "shorter", targetWords: 50 })]);
      expect(shorter[0]!.text).toMatch(/about 50 words\?$/);
      // Two out of five isn't a habit.
      expect(
        proposeSuggestions([
          ...Array(2).fill(sig({ firstSentenceCut: true })),
          ...Array(3).fill(sig()),
        ]),
      ).toEqual([]);
      expect(
        proposeSuggestions(Array(5).fill(sig({ firstSentenceCut: true }))).map((s) => s.kind),
      ).toEqual(["skip_opener"]);
      expect(
        proposeSuggestions(Array(6).fill(sig({ toneShift: "more_formal" }))).map((s) => s.kind),
      ).toEqual(["more_formal"]);
    });
  });

  describe("in the database", () => {
    let database: Database;
    let workspaceId: string;
    let mailboxId: string;

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
      await database.insert(voiceProfiles).values({
        workspaceId,
        status: "ready",
        summary: "Short and friendly.",
        avgLengthWords: 90,
        formality: "neutral",
      });
    });

    async function editedSends(n: number) {
      for (let i = 0; i < n; i++) {
        const [t] = await database
          .insert(threads)
          .values({ mailboxId, gmailThreadId: `t${i}`, inInbox: true })
          .returning();
        await database.insert(drafts).values({
          threadId: t!.id,
          mailboxId,
          toAddress: "dana@x.com",
          subject: "Re: Deck",
          body: SENT,
          originalBody: DRAFTED,
          reason: "r",
          status: "edited_and_sent",
          decidedAt: new Date(NOW.getTime() - 86_400_000),
        });
      }
    }

    it("stores counts and a tone word — never the words — then asks; nothing changes until yes", async () => {
      await editedSends(5);
      const { transport, calls } = fakeTransport(Array(5).fill({ tone_shift: "cooler" }));
      setModelTransportForTests(transport);

      expect(await captureEditSignals(NOW)).toBe(5);
      expect(await captureEditSignals(NOW)).toBe(0); // idempotent
      expect(calls).toHaveLength(5);
      const [row] = await database.select().from(editSignals);
      expect(Object.keys(row!).sort()).toEqual(
        [
          "createdAt",
          "draftId",
          "firstSentenceCut",
          "openingChanged",
          "sentencesAdded",
          "sentencesRemoved",
          "signoffChanged",
          "toneShift",
          "wordsAfter",
          "wordsBefore",
          "workspaceId",
        ].sort(),
      );
      expect(row!.toneShift).toBe("cooler");

      expect(await proposeVoiceUpdates(NOW)).toBe(3);
      expect(await proposeVoiceUpdates(NOW)).toBe(0); // not asked twice
      const ideas = await openSuggestions(workspaceId);
      expect(ideas.map((i) => i.kind).sort()).toEqual(["shorter", "signoff", "skip_opener"]);
      // Proposing changed nothing.
      const [before] = await database.select().from(voiceProfiles);
      expect(before!.avgLengthWords).toBe(90);

      const shorter = ideas.find((i) => i.kind === "shorter")!;
      expect(await decideSuggestion(workspaceId, shorter.id, true, NOW)).toBe("accepted");
      const opener = ideas.find((i) => i.kind === "skip_opener")!;
      expect(await decideSuggestion(workspaceId, opener.id, false, NOW)).toBe("ignored");
      const signoff = ideas.find((i) => i.kind === "signoff")!;
      expect(await decideSuggestion(workspaceId, signoff.id, true, NOW)).toBe("type_it");

      const [after] = await database.select().from(voiceProfiles);
      expect(after!.avgLengthWords).toBe(20); // never below 20 words
      expect(after!.source).toBe("edited");
      expect(after!.summary).toBe("Short and friendly."); // the "no" changed nothing
      // Answered ideas aren't asked again for a while.
      expect(await proposeVoiceUpdates(new Date(NOW.getTime() + 7 * 86_400_000))).toBe(0);
    });

    it("another workspace can't answer someone's idea", async () => {
      await database
        .insert(voiceSuggestions)
        .values({ workspaceId, kind: "warmer", text: "Warmer?" });
      const [idea] = await database.select().from(voiceSuggestions);
      const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
      expect(await decideSuggestion(other.workspace.id, idea!.id, true, NOW)).toBe("not_found");
    });

    it("read-only accounts are left alone: no model call", async () => {
      await editedSends(2);
      await database
        .update(workspaces)
        .set({ status: "canceled" })
        .where(eq(workspaces.id, workspaceId));
      const { transport, calls } = fakeTransport([]);
      setModelTransportForTests(transport);
      expect(await captureEditSignals(NOW)).toBe(0);
      expect(calls).toEqual([]);
    });
  });
});
