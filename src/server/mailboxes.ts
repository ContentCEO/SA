import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { mailboxLimitFor } from "@/config/pricing";
import { db } from "@/db";
import { activityLog, mailboxes, type Mailbox, type Workspace } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { ConnectResult, MailboxConnector } from "@/mailbox/connector";
import { effectivePlan } from "./referral-rules";
import {
  clearMailboxCountdowns,
  resumedInboxStatus,
  resumeOverPlanInboxes,
  startEvaluation,
} from "./workspace-lifecycle";

/** What the UI may see about a mailbox. Never includes the token. */
export type MailboxSummary = Pick<
  Mailbox,
  | "id"
  | "email"
  | "provider"
  | "status"
  | "connectedAt"
  | "backfillCompletedAt"
  | "lastSyncedAt"
  | "watchExpiresAt"
  | "lastSyncErrorCode"
  | "pausedReason"
>;

/**
 * How many inboxes the plan that counts includes (a free referral month's plan while it runs:
 * `effectivePlan`). Before a plan is chosen (evaluation), a workspace gets one mailbox.
 */
export function mailboxLimit(
  workspace: Pick<Workspace, "plan" | "freePlan" | "freePlanUntil">,
  now: Date = new Date(),
): number {
  return mailboxLimitFor(effectivePlan(workspace, now));
}

/**
 * The plan's inboxes are all in use. `paused_over_plan`: the owner reconnected an inbox that is
 * paused for being over the plan — it stays paused until they switch it on instead of another
 * one, or move up a plan.
 */
export class MailboxLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly reason: "limit" | "paused_over_plan" = "limit",
  ) {
    super(`Mailbox limit reached (${limit}).`);
    this.name = "MailboxLimitError";
  }
}

export async function listMailboxes(workspaceId: string): Promise<MailboxSummary[]> {
  return (
    db()
      .select({
        id: mailboxes.id,
        email: mailboxes.email,
        provider: mailboxes.provider,
        status: mailboxes.status,
        connectedAt: mailboxes.connectedAt,
        backfillCompletedAt: mailboxes.backfillCompletedAt,
        lastSyncedAt: mailboxes.lastSyncedAt,
        watchExpiresAt: mailboxes.watchExpiresAt,
        lastSyncErrorCode: mailboxes.lastSyncErrorCode,
        pausedReason: mailboxes.pausedReason,
      })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
      // Oldest-created first, the order the plan's inbox limit ranks by (a reconnect never moves
      // an inbox down the list).
      .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id))
  );
}

/**
 * Save (or refresh) a connected mailbox. Reconnecting the same address replaces
 * its token and clears `reconnect_needed`; a new address counts against the plan limit.
 * Inboxes paused for being over the plan don't count; reconnecting one switches it back on
 * only while there is room for it (plan #47 offer A, §3.6).
 */
export async function saveConnectedMailbox(
  workspace: Pick<Workspace, "id" | "plan" | "freePlan" | "freePlanUntil">,
  result: ConnectResult,
): Promise<MailboxSummary> {
  const email = result.email.toLowerCase();
  const existing = await listMailboxes(workspace.id);
  const same = existing.find((m) => m.email.toLowerCase() === email);
  const isReconnect = !!same;
  const limit = mailboxLimit(workspace);
  const counted = existing.filter((m) => m.pausedReason == null).length;
  if (!isReconnect && counted >= limit) throw new MailboxLimitError(limit);
  if (same?.pausedReason === "over_plan" && counted >= limit)
    throw new MailboxLimitError(limit, "paused_over_plan");

  const values = {
    encryptedRefreshToken: encryptSecret(result.refreshToken),
    scopes: result.grantedScopes.join(" "),
    status: "active" as const,
    pausedReason: null,
    connectedAt: new Date(),
    accessLostAt: null,
    accessAlertsSent: 0,
    lastSyncErrorCode: null,
    lastSyncErrorAt: null,
  };

  const [row] = isReconnect
    ? await db()
        .update(mailboxes)
        .set(values)
        .where(
          and(eq(mailboxes.workspaceId, workspace.id), sql`lower(${mailboxes.email}) = ${email}`),
        )
        .returning()
    : await db()
        .insert(mailboxes)
        .values({ workspaceId: workspace.id, provider: "gmail", email, ...values })
        .returning();
  if (!row) throw new Error("Could not save mailbox.");

  await db()
    .insert(activityLog)
    .values({
      workspaceId: workspace.id,
      actor: "owner",
      action: isReconnect ? "mailbox_reconnected" : "mailbox_connected",
      detail: { mailboxId: row.id, provider: row.provider },
    });

  // The three-day clock starts the first time Gmail is connected (no-op after that).
  await startEvaluation(workspace.id);

  return {
    id: row.id,
    email: row.email,
    provider: row.provider,
    status: row.status,
    connectedAt: row.connectedAt,
    backfillCompletedAt: row.backfillCompletedAt,
    lastSyncedAt: row.lastSyncedAt,
    watchExpiresAt: row.watchExpiresAt,
    lastSyncErrorCode: row.lastSyncErrorCode,
    pausedReason: row.pausedReason,
  };
}

/**
 * Disconnect: revoke our access at Google, then delete the mailbox; the cascade
 * removes everything synced from it (threads, messages, drafts and their edit
 * counts, price memory). Workspace-level rows stay: writing style and style
 * suggestions, business details, activity history, usage counts, seasonal notes,
 * phone notifications. Scoped to the caller's workspace so nobody can disconnect
 * someone else's mailbox.
 */
export async function disconnectMailbox(
  workspaceId: string,
  mailboxId: string,
  connector: MailboxConnector,
): Promise<boolean> {
  const [row] = await db()
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspaceId, workspaceId)));
  if (!row) return false;

  let revoked = true;
  try {
    await connector.revoke(decryptSecret(row.encryptedRefreshToken));
  } catch {
    // Still delete our copy — the owner asked us to let go. They can also remove
    // access at myaccount.google.com/permissions; the UI says so.
    revoked = false;
  }

  await db().delete(mailboxes).where(eq(mailboxes.id, row.id));
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "mailbox_disconnected",
      detail: { mailboxId: row.id, provider: row.provider, revokedAtProvider: revoked },
    });
  // A slot freed up: an inbox paused for being over the plan may switch back on. The
  // disconnect the owner asked for has happened either way.
  try {
    await resumeOverPlanInboxes(workspaceId);
  } catch (err) {
    console.error("resume_over_plan_failed", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return true;
}

export class InboxSwapError extends Error {
  constructor(public readonly code: "not_paused" | "not_on") {
    super(code === "not_paused" ? "That inbox isn't paused." : "That inbox isn't on.");
    this.name = "InboxSwapError";
  }
}

/**
 * The owner's choice (Settings → Your Gmail, "Switch this one on instead"): an inbox paused for
 * being over the plan switches on, and one that is on pauses in its place, in one transaction,
 * so the plan's limit holds. Both must be this workspace's. Nothing is deleted; the paused
 * one's autopilot countdowns stop. (The action in front of it applies the Gmail-connect rate
 * limit.)
 */
export async function swapPausedInbox(
  workspaceId: string,
  resumeId: string,
  pauseId: string,
  now: Date = new Date(),
): Promise<void> {
  if (resumeId === pauseId) throw new InboxSwapError("not_on");
  await db().transaction(async (tx) => {
    const [paused] = await tx
      .update(mailboxes)
      .set({ status: "paused", pausedReason: "over_plan" })
      .where(
        and(
          eq(mailboxes.id, pauseId),
          eq(mailboxes.workspaceId, workspaceId),
          isNull(mailboxes.pausedReason),
        ),
      )
      .returning({ id: mailboxes.id });
    if (!paused) throw new InboxSwapError("not_on");
    const [resumed] = await tx
      .update(mailboxes)
      .set({ status: resumedInboxStatus, pausedReason: null })
      .where(
        and(
          eq(mailboxes.id, resumeId),
          eq(mailboxes.workspaceId, workspaceId),
          eq(mailboxes.pausedReason, "over_plan"),
        ),
      )
      .returning({ id: mailboxes.id });
    if (!resumed) throw new InboxSwapError("not_paused");
    await clearMailboxCountdowns([pauseId], tx);
    await tx.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "inbox_swapped",
      detail: {},
      createdAt: now,
    });
  });
}

export async function getMailboxWorkspace(mailboxId: string): Promise<string | null> {
  const [row] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return row?.workspaceId ?? null;
}
