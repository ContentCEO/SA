import "server-only";
import { and, eq, exists, isNotNull, isNull, not, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db";
import {
  activityLog,
  referralCredits,
  users,
  workspaces,
  type ReferralSkipReason,
} from "@/db/schema";
import { stripeMode } from "./billing";
import { effectiveStatus } from "./lifecycle";
import {
  isReferralCode,
  isUniqueViolation,
  newReferralCode,
  referralLink,
  referralRefusal,
  referralReward,
  referredEmailHash,
} from "./referral-rules";

/**
 * Plan #47 referrals (behind FEATURE_REFERRALS). Offer A: the referrer's next month free, one
 * plan up. Logs carry ids and fixed codes only (A3) — never an email, a name, a Stripe customer
 * id or an error message.
 */

/** This workspace's referral code, made the first time it's needed. Stable afterwards. */
export async function ensureReferralCode(workspaceId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [w] = await db()
      .select({ code: workspaces.referralCode })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!w) throw new Error("Workspace not found.");
    if (w.code) return w.code;
    try {
      await db()
        .update(workspaces)
        .set({ referralCode: newReferralCode() })
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.referralCode)));
    } catch (err) {
      // Another workspace already has that code (1 in 2^72): try a new one. Anything else
      // (a dropped connection, a timeout) is not ours to swallow.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("Could not make a referral code.");
}

/**
 * The owner's share link for Plan & billing, or null if the code can't be made right now. A
 * side feature must never stop the page where the owner pays or updates their card: the
 * failure is logged (workspace id and error name only) and the section is hidden.
 */
export async function referralLinkFor(workspaceId: string): Promise<string | null> {
  try {
    return referralLink(await ensureReferralCode(workspaceId));
  } catch (err) {
    console.error("referral_code_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/** The workspace a referral code belongs to, or null (malformed or unknown codes too). */
export async function workspaceByReferralCode(code: unknown): Promise<string | null> {
  if (!isReferralCode(code)) return null;
  const [w] = await db()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.referralCode, code));
  return w?.id ?? null;
}

async function ownerOf(workspaceId: string) {
  const [row] = await db()
    .select({ workspace: workspaces, email: users.email })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(eq(workspaces.id, workspaceId));
  return row;
}

/**
 * Settle a referral, once ever (A9), the first time the referred workspace is active. The
 * referred owner must have really paid through Stripe (A27). Offer A: the referrer earns one
 * free month, one plan up, written as a `pending` row tagged with the Stripe mode it was earned
 * in; booking it on their subscription is the reward engine's job. Self, same-business-domain
 * and house-account referrers, or the switch being off at that moment, settle it as one
 * `skipped` row with the reason, and it is never given later. Returns what happened.
 */
export async function creditReferralOnActive(
  referredWorkspaceId: string,
  now: Date = new Date(),
): Promise<"earned" | "skipped"> {
  const referred = await ownerOf(referredWorkspaceId);
  const referrerId = referred?.workspace.referredByWorkspaceId;
  if (!referred || !referrerId) return "skipped";
  if (effectiveStatus(referred.workspace, now) !== "active") return "skipped";
  if (referred.workspace.setupPaidVia !== "stripe") return "skipped";
  // The referrer's workspace is gone (deleted mid-check): the FK clears the link, nothing to do.
  const referrer = await ownerOf(referrerId);
  if (!referrer) return "skipped";
  const refused = referralRefusal(
    { workspaceId: referrerId, ownerEmail: referrer.email },
    { workspaceId: referredWorkspaceId, ownerEmail: referred.email },
  );
  // Davi's own house account has no bill to make free.
  const skipReason: ReferralSkipReason | null =
    refused ??
    (referrer.workspace.setupPaidVia === "house" ? "house" : null) ??
    (referralReward() ? null : "off");

  const hash = referredEmailHash(referred.email);
  const inserted = await db().transaction(async (tx) => {
    // Two callers at once (webhook + sweep) queue here, so only one settles it.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral:${hash}`}))`);
    const [settled] = await tx
      .select({ id: referralCredits.id, referredWorkspaceId: referralCredits.referredWorkspaceId })
      .from(referralCredits)
      .where(eq(referralCredits.referredEmailSha256, hash))
      .limit(1);
    if (settled) {
      // This email's referral was settled by an earlier (since deleted) workspace: it's used
      // up. Drop the link so the sweep doesn't pick this workspace up every 15 minutes.
      if (settled.referredWorkspaceId !== referredWorkspaceId) {
        await tx
          .update(workspaces)
          .set({ referredByWorkspaceId: null })
          .where(eq(workspaces.id, referredWorkspaceId));
      }
      return [];
    }
    return tx
      .insert(referralCredits)
      .values({
        referredWorkspaceId,
        referredEmailSha256: hash,
        beneficiaryWorkspaceId: referrerId,
        side: "referrer",
        amountCents: 0,
        reward: "free_month_up",
        status: skipReason ? "skipped" : "pending",
        skipReason,
        stripeMode: skipReason ? null : stripeMode(),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: referralCredits.id });
  });
  if (skipReason || inserted.length === 0) return "skipped";
  await db().insert(activityLog).values({
    workspaceId: referrerId,
    actor: "squared_away",
    action: "referral_reward_earned",
    detail: {},
    createdAt: now,
  });
  return "earned";
}

/**
 * The 15-minute backstop: settle active referred workspaces whose move to active didn't reach
 * creditReferralOnActive. One bad account never stops the rest (A29). No-op while referrals are
 * off. (Booking earned months on Stripe comes with the reward engine.)
 */
export async function applyPendingReferralCredits(now: Date = new Date()) {
  const result = { settled: 0 };
  if (!referralReward()) return result;

  const unsettled = await db()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.status, "active"),
        eq(workspaces.setupPaidVia, "stripe"),
        isNotNull(workspaces.referredByWorkspaceId),
        not(
          exists(
            db()
              .select({ id: referralCredits.id })
              .from(referralCredits)
              .where(eq(referralCredits.referredWorkspaceId, workspaces.id)),
          ),
        ),
      ),
    );
  for (const w of unsettled) {
    try {
      if ((await creditReferralOnActive(w.id, now)) !== "skipped") result.settled++;
    } catch (err) {
      console.error("referral_settle_failed", {
        referredWorkspaceId: w.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return result;
}

/**
 * Bring this workspace's free months in line with its live subscription (plan #47, design
 * §1.4–1.7, §3.7). Filled in by the reward engine.
 */
export async function reconcileReferralRewards(
  workspaceId: string,
  sub: Stripe.Subscription | null,
  now: Date = new Date(),
): Promise<void> {
  void workspaceId;
  void sub;
  void now;
}

/**
 * For the Stripe webhook: reconcile the free months from the fresh subscription read, but never
 * fail the webhook (a Stripe 5xx in an invoice read must not undo the status and plan it just
 * applied). Logs ids and the error's name only; the 15-minute sweep catches up.
 */
export async function reconcileReferralSafely(
  workspaceId: string,
  sub: Stripe.Subscription | null,
  now: Date = new Date(),
) {
  try {
    await reconcileReferralRewards(workspaceId, sub, now);
  } catch (err) {
    console.error("referral_reconcile_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * For the status hooks (admin "setup call done", Stripe webhook): settle the referral, but never
 * fail or undo the move that called it. The sweep tries again.
 */
export async function creditReferralSafely(referredWorkspaceId: string, now: Date = new Date()) {
  try {
    return await creditReferralOnActive(referredWorkspaceId, now);
  } catch (err) {
    console.error("referral_settle_failed", {
      referredWorkspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "skipped" as const;
  }
}
