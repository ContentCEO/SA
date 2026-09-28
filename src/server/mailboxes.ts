import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { pricing } from "@/config/pricing";
import { db } from "@/db";
import { activityLog, mailboxes, type Mailbox, type Workspace } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { ConnectResult, MailboxConnector } from "@/mailbox/connector";

/** What the UI may see about a mailbox. Never includes the token. */
export type MailboxSummary = Pick<
  Mailbox,
  "id" | "email" | "provider" | "status" | "connectedAt" | "backfillCompletedAt" | "lastSyncedAt"
>;

/** Before a plan is chosen (evaluation), a workspace gets one mailbox. */
export function mailboxLimit(workspace: Pick<Workspace, "plan">): number {
  return workspace.plan ? pricing.plans[workspace.plan].mailboxLimit : 1;
}

export class MailboxLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`Mailbox limit reached (${limit}).`);
    this.name = "MailboxLimitError";
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
  const existing = await listMailboxes(workspace.id);
  const isReconnect = existing.some((m) => m.email.toLowerCase() === email);
  const limit = mailboxLimit(workspace);
  if (!isReconnect && existing.length >= limit) throw new MailboxLimitError(limit);

  const values = {
    encryptedRefreshToken: encryptSecret(result.refreshToken),
    scopes: result.grantedScopes.join(" "),
    status: "active" as const,
    connectedAt: new Date(),
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

  return {
    id: row.id,
    email: row.email,
    provider: row.provider,
    status: row.status,
    connectedAt: row.connectedAt,
    backfillCompletedAt: row.backfillCompletedAt,
    lastSyncedAt: row.lastSyncedAt,
  };
}

/**
 * Disconnect: revoke our access at Google, then delete the mailbox (and, via
 * cascade in later milestones, everything synced from it). Scoped to the
 * caller's workspace so nobody can disconnect someone else's mailbox.
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
  return true;
}
