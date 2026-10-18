import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, appSettings, voiceProfiles, voiceSuggestions } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { runVoiceIdeaCleanup, VOICE_IDEA_CLEANUP_KEY } from "@/server/voice-idea-cleanup";
import { createTestDb } from "../support/db";

const NOW = new Date("2026-10-18T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let database: Database;
let n = 0;

beforeEach(async () => {
  database = await createTestDb();
}, 30_000);

async function shop(voice: { source: "learned" | "edited" }) {
  const { workspace } = await ensureUserAndWorkspace({ email: `owner${++n}@shop.com` });
  await database
    .insert(voiceProfiles)
    .values({ workspaceId: workspace.id, status: "ready", summary: "Short.", ...voice });
  return workspace.id;
}
const learned = (workspaceId: string, at: Date) =>
  database
    .insert(activityLog)
    .values({ workspaceId, actor: "squared_away", action: "voice_learned", createdAt: at });
const typed = (workspaceId: string, at: Date) =>
  database
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "voice_profile_edited", createdAt: at });
const accepted = (workspaceId: string, at: Date) =>
  database.insert(voiceSuggestions).values({
    workspaceId,
    kind: "shorter",
    text: "Make replies shorter?",
    targetWords: 40,
    status: "accepted",
    decidedAt: at,
  });
const sourceOf = async (workspaceId: string) =>
  (
    await database.select().from(voiceProfiles).where(eq(voiceProfiles.workspaceId, workspaceId))
  )[0]!.source;

describe("one-off: voices edited only by an accepted idea go back on the weekly refresh", () => {
  it("restores a voice marked edited by an idea accepted after its last learn", async () => {
    const ws = await shop({ source: "edited" });
    await learned(ws, ago(48));
    await accepted(ws, ago(24));
    expect(await runVoiceIdeaCleanup(NOW)).toEqual({ ran: true, restored: 1 });
    expect(await sourceOf(ws)).toBe("learned");
  });

  it("keeps a voice the owner typed edits into after the last learn, idea or not", async () => {
    const ws = await shop({ source: "edited" });
    await learned(ws, ago(72));
    await accepted(ws, ago(48));
    await typed(ws, ago(24));
    const before = await shop({ source: "edited" }); // typed first, then an idea: still typed
    await learned(before, ago(72));
    await typed(before, ago(48));
    await accepted(before, ago(24));
    expect(await runVoiceIdeaCleanup(NOW)).toEqual({ ran: true, restored: 0 });
    expect(await sourceOf(ws)).toBe("edited");
    expect(await sourceOf(before)).toBe("edited");
  });

  it("counts a typed edit from before a forced re-learn as gone", async () => {
    const ws = await shop({ source: "edited" });
    await typed(ws, ago(96));
    await learned(ws, ago(72)); // "Re-learn from my sent mail" overwrote the typed edit
    await accepted(ws, ago(24));
    await runVoiceIdeaCleanup(NOW);
    expect(await sourceOf(ws)).toBe("learned");
  });

  it("leaves an edited voice with no accepted idea since its last learn, and learned voices", async () => {
    const old = await shop({ source: "edited" });
    await accepted(old, ago(96));
    await learned(old, ago(72)); // the idea predates this learn: the edit came from elsewhere
    const plain = await shop({ source: "learned" });
    await accepted(plain, ago(24));
    expect(await runVoiceIdeaCleanup(NOW)).toEqual({ ran: true, restored: 0 });
    expect(await sourceOf(old)).toBe("edited");
    expect(await sourceOf(plain)).toBe("learned");
  });

  it("runs once: the marker is written, and a second run changes nothing", async () => {
    const ws = await shop({ source: "edited" });
    await accepted(ws, ago(24));
    expect(await runVoiceIdeaCleanup(NOW)).toEqual({ ran: true, restored: 1 });
    const [marker] = await database
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, VOICE_IDEA_CLEANUP_KEY));
    expect(marker).toBeDefined();
    await database.update(voiceProfiles).set({ source: "edited" });
    expect(await runVoiceIdeaCleanup(NOW)).toEqual({ ran: false });
    expect(await sourceOf(ws)).toBe("edited");
  });
});
