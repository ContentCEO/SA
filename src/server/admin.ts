import "server-only";
import { and, count, desc, eq, gte, inArray, max, sql, sum } from "drizzle-orm";
import { utcDay } from "@/ai/usage";
import { db } from "@/db";
import { drafts, invites, mailboxes, tradeEnum, usage, users, workspaces } from "@/db/schema";
import { normalizeEmail } from "./accounts";
import { effectiveStatus } from "./lifecycle";

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
  mailboxes: { total: number; needReconnect: number; lastSyncedAt: Date | null };
  drafts: { pending: number; sentLast7Days: number; createdThisMonth: number };
  ai: { callsToday: number; callsThisMonth: number; costCentsThisMonth: number };
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

  const ws = await db()
    .select({
      id: workspaces.id,
      ownerEmail: users.email,
      businessName: workspaces.businessName,
      trade: workspaces.trade,
      status: workspaces.status,
      plan: workspaces.plan,
      evaluationEndsAt: workspaces.evaluationEndsAt,
      setupPaidAt: workspaces.setupPaidAt,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .orderBy(desc(workspaces.createdAt))
    .limit(ADMIN_PAGE_SIZE);
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

  const by = <T extends { workspaceId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.workspaceId, r]));
  const b = by(boxes);
  const d = by(draftCounts);
  const m = by(month);

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
  }));
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
