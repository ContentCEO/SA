import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, like, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

/**
 * Check 9 P9: one drafting run per thread at a time. A double tap on "Draft a reply" (or a tap
 * while the background job is writing the same one) used to run the model twice, write two
 * Gmail drafts and count twice against the AI cap. The run takes a short lease first, in one
 * atomic upsert (it holds across serverless instances); a second run that finds a live lease
 * stands down before any Gmail read or model call. The row holds only the thread id and a
 * random token — no content.
 */
export const DRAFT_CLAIM_MS = 2 * 60_000;
const PREFIX = "draft-claim:";

/** A token when this run holds the thread's lease, else null (another run is writing). */
export async function claimDrafting(threadId: string, now: Date = new Date()) {
  const token = randomUUID();
  const expired = new Date(now.getTime() - DRAFT_CLAIM_MS).toISOString();
  const rows = await db()
    .insert(appSettings)
    .values({ key: PREFIX + threadId, value: token, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: token, updatedAt: now },
      where: sql`${appSettings.updatedAt} < ${expired}::timestamptz`,
    })
    .returning({ value: appSettings.value });
  return rows[0]?.value === token ? token : null;
}

/** Hands the lease back (only this run's own; a lease another run took over is left alone). */
export async function releaseDrafting(threadId: string, token: string) {
  await db()
    .delete(appSettings)
    .where(and(eq(appSettings.key, PREFIX + threadId), eq(appSettings.value, token)));
}

/** Leases left by a run that died (daily purge). */
export async function purgeStaleDraftClaims(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  await db()
    .delete(appSettings)
    .where(and(like(appSettings.key, `${PREFIX}%`), lt(appSettings.updatedAt, cutoff)));
}
