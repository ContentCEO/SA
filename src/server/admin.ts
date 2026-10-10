import "server-only";
import { and, count, desc, eq, gte, inArray, max, sql, sum } from "drizzle-orm";
import { utcDay } from "@/ai/usage";
import { db } from "@/db";
import {
  activityLog,
  drafts,
  invites,
  mailboxes,
  threads,
  tradeEnum,
  usage,
  users,
  workspaces,
} from "@/db/schema";
import { normalizeEmail } from "./accounts";
import { effectiveStatus, jobsAllowed } from "./lifecycle";

export function isAdminEmail(email: string | null | undefined): boolean {
  const admin = process.env.ADMIN_EMAIL;
  return Boolean(email && admin && normalizeEmail(email) === normalizeEmail(admin));
}

export type AdminRow = {
  workspaceId: string;
  ownerEmail: string;
  businessName: string | null;
  trade: string | null;
  status: (typeof workspaces.$inferSelect)["status"];
  storedStatus: (typeof workspaces.$inferSelect)["status"];
  plan: string | null;
  evaluationEndsAt: Date | null;
  setupPaidAt: Date | null;
  setupPaidVia: "stripe" | "house" | null;
  mailboxes: { total: number; needReconnect: number; lastSyncedAt: Date | null };
  drafts: { pending: number; sentLast7Days: number; createdThisMonth: number };
  ai: { callsToday: number; callsThisMonth: number; costCentsThisMonth: number };
  /** When each part of the pipeline last did something for this account. */
  health: { lastSortedAt: Date | null; lastDraftAt: Date | null; lastDigestAt: Date | null };
  createdAt: Date;
};

/**
 * Operational health only. Deliberately selects no thread, message or draft
 * text, subjects, or customer addresses — just counts, statuses and money.
 */
export const ADMIN_PAGE_SIZE = 50;

export async function countWorkspaces(): Promise<number> {
  const [row] = await db().select({ n: count() }).from(workspaces);
  return row?.n ?? 0;
}

/** Newest accounts first, at most `ADMIN_PAGE_SIZE`. */
export async function adminOverview(now: Date = new Date()): Promise<AdminRow[]> {
  const monthStart = `${utcDay(now).slice(0, 7)}-01`;
  const today = utcDay(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthStartDate = new Date(`${monthStart}T00:00:00Z`);

  const columns = {
    id: workspaces.id,
    ownerEmail: users.email,
    businessName: workspaces.businessName,
    trade: workspaces.trade,
    status: workspaces.status,
    plan: workspaces.plan,
    evaluationEndsAt: workspaces.evaluationEndsAt,
    setupPaidAt: workspaces.setupPaidAt,
    setupPaidVia: workspaces.setupPaidVia,
    createdAt: workspaces.createdAt,
  };
  const newest = await db()
    .select(columns)
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .orderBy(desc(workspaces.createdAt))
    .limit(ADMIN_PAGE_SIZE);
  // Davi's own account is always shown first, however many newer accounts there are.
  const adminEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : null;
  const own = adminEmail
    ? await db()
        .select(columns)
        .from(workspaces)
        .innerJoin(users, eq(users.id, workspaces.ownerUserId))
        .where(eq(users.email, adminEmail))
    : [];
  const ws = [...own, ...newest.filter((w) => !own.some((o) => o.id === w.id))];
  if (ws.length === 0) return [];
  const ids = ws.map((w) => w.id);

  const boxes = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      total: sql<number>`count(*)::int`,
      needReconnect: sql<number>`count(*) filter (where ${mailboxes.status} = 'reconnect_needed')::int`,
      lastSyncedAt: max(mailboxes.lastSyncedAt),
    })
    .from(mailboxes)
    .where(inArray(mailboxes.workspaceId, ids))
    .groupBy(mailboxes.workspaceId);

  const draftCounts = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      pending: sql<number>`count(*) filter (where ${drafts.status} = 'pending')::int`,
      sent: sql<number>`count(*) filter (where ${drafts.status} in ('sent', 'edited_and_sent') and ${drafts.decidedAt} >= ${weekAgo.toISOString()}::timestamptz)::int`,
      created: sql<number>`count(*) filter (where ${drafts.createdAt} >= ${monthStartDate.toISOString()}::timestamptz)::int`,
    })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(inArray(mailboxes.workspaceId, ids))
    .groupBy(mailboxes.workspaceId);

  const month = await db()
    .select({
      workspaceId: usage.workspaceId,
      calls: sum(usage.aiCalls).mapWith(Number),
      cost: sum(usage.estimatedCostCentiCents).mapWith(Number),
      callsToday: sql<number>`coalesce(sum(${usage.aiCalls}) filter (where ${usage.period} = ${today}), 0)::int`,
    })
    .from(usage)
    .where(and(inArray(usage.workspaceId, ids), gte(usage.period, monthStart)))
    .groupBy(usage.workspaceId);

  const sorted = await db()
    .select({ workspaceId: mailboxes.workspaceId, at: max(threads.classifiedAt) })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(inArray(mailboxes.workspaceId, ids))
    .groupBy(mailboxes.workspaceId);
  const drafted = await db()
    .select({ workspaceId: mailboxes.workspaceId, at: max(drafts.createdAt) })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(inArray(mailboxes.workspaceId, ids))
    .groupBy(mailboxes.workspaceId);
  const digests = await db()
    .select({ workspaceId: activityLog.workspaceId, at: max(activityLog.createdAt) })
    .from(activityLog)
    .where(and(inArray(activityLog.workspaceId, ids), eq(activityLog.action, "digest_sent")))
    .groupBy(activityLog.workspaceId);

  const by = <T extends { workspaceId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.workspaceId, r]));
  const b = by(boxes);
  const d = by(draftCounts);
  const m = by(month);
  const hs = by(sorted);
  const hd = by(drafted);
  const hg = by(digests);

  return ws.map((w) => ({
    workspaceId: w.id,
    ownerEmail: w.ownerEmail,
    businessName: w.businessName,
    trade: w.trade,
    status: effectiveStatus(w, now),
    storedStatus: w.status,
    plan: w.plan,
    evaluationEndsAt: w.evaluationEndsAt,
    setupPaidAt: w.setupPaidAt,
    setupPaidVia: w.setupPaidVia,
    createdAt: w.createdAt,
    mailboxes: {
      total: b.get(w.id)?.total ?? 0,
      needReconnect: b.get(w.id)?.needReconnect ?? 0,
      lastSyncedAt: b.get(w.id)?.lastSyncedAt ?? null,
    },
    drafts: {
      pending: d.get(w.id)?.pending ?? 0,
      sentLast7Days: d.get(w.id)?.sent ?? 0,
      createdThisMonth: d.get(w.id)?.created ?? 0,
    },
    ai: {
      callsToday: m.get(w.id)?.callsToday ?? 0,
      callsThisMonth: m.get(w.id)?.calls ?? 0,
      costCentsThisMonth: Math.round((m.get(w.id)?.cost ?? 0) / 100),
    },
    health: {
      lastSortedAt: hs.get(w.id)?.at ?? null,
      lastDraftAt: hd.get(w.id)?.at ?? null,
      lastDigestAt: hg.get(w.id)?.at ?? null,
    },
  }));
}

/** The 5-minute poll syncs every working mailbox; much older than that means jobs stopped. */
export const JOBS_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * App-wide health for the top of /admin: are background jobs running, and how
 * many mailboxes need their owner to reconnect. Counts only.
 */
export async function systemHealth(now: Date = new Date()) {
  const rows = await db()
    .select({
      status: mailboxes.status,
      lastSyncedAt: mailboxes.lastSyncedAt,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      workspace: { status: workspaces.status, evaluationEndsAt: workspaces.evaluationEndsAt },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId));
  const working = rows.filter(
    (r) => r.status === "active" && r.backfillCompletedAt && jobsAllowed(r.workspace, now),
  );
  const newest = working.reduce<Date | null>(
    (a, r) => (r.lastSyncedAt && (!a || r.lastSyncedAt > a) ? r.lastSyncedAt : a),
    null,
  );
  return {
    workingMailboxes: working.length,
    needReconnect: rows.filter((r) => r.status === "reconnect_needed").length,
    lastSyncAt: newest,
    jobsLookStopped:
      working.length > 0 && (!newest || now.getTime() - newest.getTime() > JOBS_STALE_AFTER_MS),
  };
}

export type Trade = (typeof tradeEnum.enumValues)[number];

/** Invite an owner (replaces `pnpm invite` for day-to-day use). Idempotent. */
export async function inviteOwner(input: {
  email: string;
  trade?: Trade | null;
  note?: string | null;
}) {
  const email = normalizeEmail(input.email);
  const [row] = await db()
    .insert(invites)
    .values({ email, trade: input.trade ?? null, note: input.note?.trim() || null })
    .onConflictDoNothing()
    .returning({ email: invites.email });
  return row ? "invited" : "already_invited";
}

export async function listInvites() {
  return db()
    .select({
      email: invites.email,
      trade: invites.trade,
      invitedAt: invites.invitedAt,
      acceptedAt: invites.acceptedAt,
    })
    .from(invites)
    .orderBy(desc(invites.invitedAt))
    .limit(ADMIN_PAGE_SIZE);
}
