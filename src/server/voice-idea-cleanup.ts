import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, voiceProfiles } from "@/db/schema";

/**
 * One-off data fix (integrator decision, wave 2, with Check 24 P7), run by the 15-minute
 * workspace-lifecycle job.
 *
 * Before Check 24 P7, saying yes to an idea from your edits marked the voice `edited`, and the
 * weekly refresh skips edited voices, so the refresh stopped for good. Now an accepted idea
 * leaves `source` alone and every learn re-applies the accepted ideas. This puts back on the
 * weekly refresh the voices that are `edited` **only** because of an accepted idea:
 *
 * - the voice row says `edited`;
 * - an idea was accepted after the newest successful learn (`voice_learned`), or ever if there
 *   was none;
 * - and the owner never typed an edit (`voice_profile_edited`) since that learn. A forced
 *   "Re-learn from my sent mail" overwrites typed edits and logs `voice_learned`, so a typed
 *   edit before it no longer counts; one after it keeps the voice edited.
 *
 * Gated by an `app_settings` key written in the same transaction, so it runs once; the update
 * only touches rows that still match, so a second run would change nothing anyway. Counts only.
 */
export const VOICE_IDEA_CLEANUP_KEY = "cleanup:voice-idea-edited-v1";

export type VoiceIdeaCleanupResult = { ran: false } | { ran: true; restored: number };

export async function runVoiceIdeaCleanup(now: Date = new Date()): Promise<VoiceIdeaCleanupResult> {
  const [done] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, VOICE_IDEA_CLEANUP_KEY));
  if (done) return { ran: false };

  return db().transaction(async (tx) => {
    const lastLearn = sql`coalesce((select max(l.created_at) from activity_log l where l.workspace_id = ${voiceProfiles.workspaceId} and l.action = 'voice_learned'), '-infinity'::timestamptz)`;
    const restored = await tx
      .update(voiceProfiles)
      .set({ source: "learned" })
      .where(
        and(
          eq(voiceProfiles.source, "edited"),
          sql`exists (select 1 from voice_suggestions s where s.workspace_id = ${voiceProfiles.workspaceId} and s.status = 'accepted' and s.decided_at > ${lastLearn})`,
          sql`not exists (select 1 from activity_log e where e.workspace_id = ${voiceProfiles.workspaceId} and e.action = 'voice_profile_edited' and e.created_at > ${lastLearn})`,
        ),
      )
      .returning({ workspaceId: voiceProfiles.workspaceId });
    await tx
      .insert(appSettings)
      .values({ key: VOICE_IDEA_CLEANUP_KEY, value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing();
    console.info("voice_idea_cleanup", { restored: restored.length });
    return { ran: true, restored: restored.length };
  });
}
