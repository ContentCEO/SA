import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { TERMS_COOKIE, TERMS_COOKIE_PATH, TERMS_VERSION } from "@/config/legal";
import { db } from "@/db";
import { users } from "@/db/schema";
import { cookieAgreesToCurrent, hasCurrentTerms } from "./terms-rules";

/** The person's last "I agree": which version (null if never). Null when there's no such user. */
export async function termsOf(userId: string): Promise<{ termsVersion: string | null } | null> {
  const [row] = await db()
    .select({ termsVersion: users.termsVersion })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}

/** Whether this person has agreed to the current terms. */
/**
 * Check 29 P7: React cache() — one query per request however many places ask (requireOwner and
 * the layout's banners). Outside a server render (jobs, tests) it is a plain call.
 */
export const termsAccepted = cache(async (userId: string): Promise<boolean> =>
  hasCurrentTerms(await termsOf(userId)),
);

/**
 * Records that this person ticked the box just now, for the current version. Never lowers a
 * newer version already on record (agreed on a preview or before a rollback, which share this
 * database): that record stays as it is. Versions are YYYY-MM-DD, compared byte by byte.
 */
export async function recordTermsAcceptance(userId: string, now: Date = new Date()) {
  await db()
    .update(users)
    .set({ termsAcceptedAt: now, termsVersion: TERMS_VERSION })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.termsVersion), sql`${users.termsVersion} collate "C" <= ${TERMS_VERSION}`),
      ),
    );
}

/**
 * At sign-in (Auth.js's jwt callback, on Google's callback request): if the sign-in button left
 * its "ticked the box" cookie for the current version, record the acceptance, and delete the
 * cookie either way. Never fails sign-in: without a record, the next screen simply asks again.
 */
export async function takeSignInAgreement(userId: string): Promise<boolean> {
  try {
    const jar = await cookies();
    const value = jar.get(TERMS_COOKIE)?.value;
    if (value === undefined) return false;
    jar.delete({ name: TERMS_COOKIE, path: TERMS_COOKIE_PATH });
    if (!cookieAgreesToCurrent(value)) return false;
    await recordTermsAcceptance(userId);
    return true;
  } catch (err) {
    console.error("terms_signin_record_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return false;
  }
}
