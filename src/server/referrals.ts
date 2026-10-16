import "server-only";
import { and, eq, exists, isNotNull, isNull, not, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activityLog,
  referralCredits,
  users,
  workspaces,
  type ReferralCredit,
  type ReferralSide,
} from "@/db/schema";
import { stripeClient } from "./billing";
import { effectiveStatus } from "./lifecycle";
import {
  errorCodeOf,
  isPermanentStripeError,
  isReferralCode,
  isUniqueViolation,
  newReferralCode,
  referralCredit,
  referralLink,
  referralRefusal,
  referredEmailHash,
} from "./referral-rules";

/**
 * Plan #47 referral credit (behind FEATURE_REFERRALS, and nothing happens while the amount in
 * src/config/pricing.ts is null). Logs carry ids and fixed codes only (A3) — never an email,
 * a name, a Stripe customer id or an error message.
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

function logFailure(row: Pick<ReferralCredit, "id" | "side">, err: unknown) {
  console.error("referral_credit_failed", {
    referralCreditId: row.id,
    side: row.side,
    error: err instanceof Error ? err.name : "unknown",
  });
}

/**
 * Settle a referral, once ever (A9), the first time the referred workspace is active. The
 * referred owner must have really paid through Stripe (A27), and self or same-business-domain
 * referrals never count. If the feature is off or has no amount at that moment, the referral
 * is settled as `skipped` and never paid later. Returns what happened for this call.
 */
export async function creditReferralOnActive(
  referredWorkspaceId: string,
  now: Date = new Date(),
): Promise<"credited" | "pending" | "skipped"> {
  const referred = await ownerOf(referredWorkspaceId);
  const referrerId = referred?.workspace.referredByWorkspaceId;
  if (!referred || !referrerId) return "skipped";
  if (effectiveStatus(referred.workspace, now) !== "active") return "skipped";
  if (referred.workspace.setupPaidVia !== "stripe") return "skipped";
  // The referrer's workspace is gone (deleted mid-check): the FK clears the link, nothing to do.
  const referrer = await ownerOf(referrerId);
  if (!referrer) return "skipped";
  const refused =
    referralRefusal(
      { workspaceId: referrerId, ownerEmail: referrer.email },
      { workspaceId: referredWorkspaceId, ownerEmail: referred.email },
    ) !== null;

  // Off, no amount, or refused (self / same business domain): decided now, as one `skipped`
  // row, so the sweep never looks at it again and it can't be paid later (A9).
  const credit = refused ? null : referralCredit();
  const hash = referredEmailHash(referred.email);
  const beneficiary: Record<ReferralSide, string> = {
    referrer: referrerId,
    referred: referredWorkspaceId,
  };
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
    const rows = credit
      ? credit.sides.map((side) => ({
          referredWorkspaceId,
          referredEmailSha256: hash,
          beneficiaryWorkspaceId: beneficiary[side],
          side,
          amountCents: credit.cents,
          status: "pending" as const,
          createdAt: now,
        }))
      : [
          {
            referredWorkspaceId,
            referredEmailSha256: hash,
            beneficiaryWorkspaceId: referrerId,
            side: "referrer" as const,
            amountCents: 0,
            status: "skipped" as const,
            createdAt: now,
          },
        ];
    if (rows.length === 0) return [];
    return tx.insert(referralCredits).values(rows).onConflictDoNothing().returning();
  });
  if (!credit) return "skipped";
  if (inserted.length === 0) return "skipped";

  let applied = 0;
  for (const row of inserted) {
    try {
      if ((await applyReferralCredit(row, now)) === "applied") applied++;
    } catch (err) {
      logFailure(row, err);
    }
  }
  return applied === inserted.length ? "credited" : "pending";
}

/**
 * Add one credit to the beneficiary's Stripe balance. No Stripe customer yet → stays pending
 * (the sweep adds it once there is one). Stripe's idempotency key only lasts about a day, so we
 * first look for a balance transaction already carrying this row's id (A22).
 */
export async function applyReferralCredit(
  row: ReferralCredit,
  now: Date = new Date(),
): Promise<"applied" | "pending" | "failed"> {
  if (row.status !== "pending" || !row.beneficiaryWorkspaceId) return "pending";
  const [b] = await db()
    .select({ customer: workspaces.stripeCustomerId })
    .from(workspaces)
    .where(eq(workspaces.id, row.beneficiaryWorkspaceId));
  if (!b?.customer) return "pending";

  let transactionId: string;
  try {
    const s = stripeClient();
    // Every page, not just the first 100: a busy customer's earlier credit can be further back.
    let found: string | undefined;
    for await (const t of s.customers.listBalanceTransactions(b.customer, { limit: 100 })) {
      if (t.metadata?.referralCreditId === row.id) {
        found = t.id;
        break;
      }
    }
    if (found) {
      transactionId = found;
    } else {
      const created = await s.customers.createBalanceTransaction(
        b.customer,
        {
          amount: -row.amountCents,
          currency: "usd",
          description: "Referral credit",
          metadata: { referralCreditId: row.id },
        },
        { idempotencyKey: `referral-${row.referredWorkspaceId ?? row.id}-${row.side}` },
      );
      transactionId = created.id;
    }
  } catch (err) {
    const permanent = isPermanentStripeError(err);
    await db()
      .update(referralCredits)
      .set({
        attempts: sql`${referralCredits.attempts} + 1`,
        lastErrorCode: errorCodeOf(err),
        ...(permanent ? { status: "failed" as const } : {}),
      })
      .where(and(eq(referralCredits.id, row.id), eq(referralCredits.status, "pending")));
    logFailure(row, err);
    return permanent ? "failed" : "pending";
  }

  const [done] = await db()
    .update(referralCredits)
    .set({ status: "applied", stripeBalanceTransactionId: transactionId, appliedAt: now })
    .where(and(eq(referralCredits.id, row.id), eq(referralCredits.status, "pending")))
    .returning({ id: referralCredits.id });
  if (done) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId: row.beneficiaryWorkspaceId,
        actor: "squared_away",
        action: "referral_credit_applied",
        detail: { side: row.side },
        createdAt: now,
      });
  }
  return "applied";
}

/**
 * The 15-minute backstop: add credits still waiting (e.g. the beneficiary has since got a
 * Stripe customer) and settle active referred workspaces whose move to active didn't reach
 * creditReferralOnActive. One bad row never stops the rest (A29). No-op while referrals pay
 * nothing — pending rows wait, and nothing new is settled.
 */
export async function applyPendingReferralCredits(now: Date = new Date()) {
  const result = { applied: 0, settled: 0 };
  if (!referralCredit()) return result;

  const pending = await db()
    .select({ row: referralCredits })
    .from(referralCredits)
    .innerJoin(workspaces, eq(workspaces.id, referralCredits.beneficiaryWorkspaceId))
    .where(and(eq(referralCredits.status, "pending"), isNotNull(workspaces.stripeCustomerId)));
  for (const { row } of pending) {
    try {
      if ((await applyReferralCredit(row, now)) === "applied") result.applied++;
    } catch (err) {
      logFailure(row, err);
    }
  }

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
