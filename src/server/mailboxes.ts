import "server-only";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, mailboxes, type Mailbox, type Workspace } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { ConnectResult, MailboxConnector } from "@/mailbox/connector";
import { fitMailboxesToPlan } from "./mailbox-plan";
import type { FirstReadProgress } from "./mailbox-health";
import { mailboxLimitFor } from "./mailbox-plan-rules";

/** Same as sync's BACKFILL_DAYS (not imported: sync imports this module's neighbours). */
const BACKFILL_DAYS_FOR_PROGRESS = 30;
import { startEvaluation } from "./workspace-lifecycle";

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
  | "planPausedAt"
  | "backfillSince"
>;

/** Before a plan is chosen (evaluation), a workspace gets one mailbox. */
export function mailboxLimit(workspace: Pick<Workspace, "plan">): number {
  return mailboxLimitFor(workspace.plan);
}

export class MailboxLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`Mailbox limit reached (${limit}).`);
    this.name = "MailboxLimitError";
  }
}

/**
 * Check 25 P7: this Gmail address is already connected to another Squared Away account (any
 * status — live, waiting for a reconnect, or paused on a plan). One Gmail is live in one
 * account only: two would read the same inbox and both write drafts into it.
 */
export class MailboxInUseError extends Error {
  constructor() {
    super("This Gmail is already connected to another account.");
    this.name = "MailboxInUseError";
  }
}

export async function listMailboxes(workspaceId: string): Promise<MailboxSummary[]> {
  return db()
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
      planPausedAt: mailboxes.planPausedAt,
      backfillSince: mailboxes.backfillSince,
    })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId))
    .orderBy(asc(mailboxes.connectedAt));
}

/**
 * Save (or refresh) a connected mailbox. Reconnecting the same address replaces
 * its token and clears `reconnect_needed`; a new address counts against the plan limit.
 */
export async function saveConnectedMailbox(
  workspace: Pick<Workspace, "id" | "plan">,
  result: ConnectResult,
): Promise<MailboxSummary> {
  const email = result.email.toLowerCase();
  // Check 25 P7: never the same Gmail in two accounts. Nothing is saved and the try is logged
  // (content-free) on the workspace that tried.
  const [elsewhere] = await db()
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(sql`lower(${mailboxes.email}) = ${email}`, ne(mailboxes.workspaceId, workspace.id)))
    .limit(1);
  if (elsewhere) {
    await db().insert(activityLog).values({
      workspaceId: workspace.id,
      actor: "owner",
      action: "mailbox_in_use_refused",
      detail: {},
    });
    throw new MailboxInUseError();
  }
  const existing = await listMailboxes(workspace.id);
  const isReconnect = existing.some((m) => m.email.toLowerCase() === email);
  const limit = mailboxLimit(workspace);
  if (!isReconnect && existing.length >= limit) throw new MailboxLimitError(limit);

  const values = {
    encryptedRefreshToken: encryptSecret(result.refreshToken),
    scopes: result.grantedScopes.join(" "),
    status: "active" as const,
    connectedAt: new Date(),
    accessLostAt: null,
    accessAlertsSent: 0,
    lastSyncErrorCode: null,
    lastSyncErrorAt: null,
    // Check 25 P5: a reconnect starts a fresh first read, never a half-finished one.
    backfillPageToken: null,
    backfillPagesDone: 0,
    backfillSince: null,
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
    planPausedAt: row.planPausedAt,
    backfillSince: row.backfillSince,
  };
}

/**
 * Check 25 P6: a first read in progress, for Settings → Your Gmail. The start is the read's
 * fixed window plus 30 days (`backfill_since` is "now − 30 days" at the begin); a read that
 * began after the owner reconnected says so instead of "for the first time". Counts only.
 */
export async function firstReadProgress(
  m: Pick<MailboxSummary, "id" | "backfillSince"> & { workspaceId: string },
  count: number,
  timeZone: string,
): Promise<FirstReadProgress> {
  const startedAt = m.backfillSince
    ? new Date(m.backfillSince.getTime() + BACKFILL_DAYS_FOR_PROGRESS * 86_400_000)
    : null;
  const [reconnect] = await db()
    .select({ at: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.workspaceId, m.workspaceId),
        eq(activityLog.action, "mailbox_reconnected"),
        sql`${activityLog.detail}->>'mailboxId' = ${m.id}`,
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  // The read restarted at (or just after) the reconnect.
  const afterReconnect =
    !!reconnect && (!startedAt || reconnect.at.getTime() <= startedAt.getTime() + 60 * 60_000);
  let startedLabel: string | null = null;
  if (startedAt) {
    try {
      startedLabel = startedAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      });
    } catch {
      startedLabel = startedAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });
    }
  }
  return { count, startedAt, startedLabel, afterReconnect };
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
  // An address the plan had paused comes back on if this one made room (2026-10-16).
  await fitMailboxesToPlan(workspaceId);
  return true;
}

export async function getMailboxWorkspace(mailboxId: string): Promise<string | null> {
  const [row] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return row?.workspaceId ?? null;
}
