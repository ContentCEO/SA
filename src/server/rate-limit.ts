import "server-only";
import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";

/**
 * Abuse limits, generous enough that a busy owner never meets them. Kept in
 * Postgres (one atomic upsert) so they hold across every serverless instance.
 */
export const LIMITS = {
  /** Public waitlist form, per IP. */
  waitlist: { max: 10, windowSec: 60 * 60 },
  /** Sending replies, per workspace. */
  send: { max: 60, windowSec: 10 * 60 },
  /** The owner's "Draft a reply" (a model call), per workspace. */
  draft: { max: 30, windowSec: 60 * 60 },
  /** Quick tweaks and voice edits on drafts (a model call each), per workspace. */
  revise: { max: 40, windowSec: 60 * 60 },
  /** Re-learn voice (reads up to 200 sent emails + a model call), per workspace. */
  relearn: { max: 3, windowSec: 24 * 60 * 60 },
  /** Starting Stripe checkout or the billing portal, per workspace. */
  billing: { max: 10, windowSec: 60 * 60 },
  /** Starting a Gmail connect, per workspace. */
  connect: { max: 10, windowSec: 60 * 60 },
  /** Texting a phone-confirmation code, per workspace. */
  smsCode: { max: 5, windowSec: 60 * 60 },
  /** Guessing the code, per workspace. */
  smsVerify: { max: 10, windowSec: 60 * 60 },
} as const;
export type LimitName = keyof typeof LIMITS;

export type LimitResult = { allowed: boolean; retryAfterSec: number };

/** Count one attempt for `who` (a workspace id or ipKey()) and say whether it's within the limit. */
export async function hitLimit(
  name: LimitName,
  who: string,
  now = new Date(),
): Promise<LimitResult> {
  const { max, windowSec } = LIMITS[name];
  const windowMs = windowSec * 1000;
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db()
    .insert(rateLimits)
    .values({ key: `${name}:${who}`, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.windowStart} = excluded.window_start then ${rateLimits.count} + 1 else 1 end`,
        windowStart: sql`excluded.window_start`,
      },
    })
    .returning({ count: rateLimits.count });
  const retryAfterSec = Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000);
  return { allowed: (row?.count ?? 1) <= max, retryAfterSec };
}

/** A stable, non-reversible key for a visitor's IP (we never store the address). */
export function ipKey(headers: Headers): string {
  const ip =
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
  const salt = process.env.AUTH_SECRET ?? "";
  return createHash("sha256").update(`${salt}:${ip}`).digest("base64url").slice(0, 22);
}

/** Daily cleanup: windows older than the longest limit are dead weight. */
export async function purgeRateLimits(now = new Date()) {
  const cutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  await db().delete(rateLimits).where(lt(rateLimits.windowStart, cutoff));
}
