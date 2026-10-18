import "server-only";
import { and, count, desc, eq, gte, inArray, max, sql, sum } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { utcDay } from "@/ai/usage";
import { db } from "@/db";
import {
  activityLog,
  drafts,
  invites,
  mailboxes,
  referralCredits,
  threads,
  tradeEnum,
  usage,
  users,
  workspaces,
} from "@/db/schema";
import { mailboxOn } from "./mailbox-plan-rules";
import { STALE_SYNC_MS } from "./mailbox-health";
import { normalizeEmail } from "./accounts";
import { effectiveStatus, jobsAllowed } from "./lifecycle";
import { referralsVisible } from "./referral-rules";
import { workspacesWithTwoPlans } from "./billing";

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
  /** Check 17 P2: Stripe has a subscription on file (never the id itself). */
  hasSubscription: boolean;
  /** Check 17 P4: Stripe has two live plans for this account (one should be canceled there). */
  twoLivePlans: boolean;
  mailboxes: {
    total: number;
    needReconnect: number;
    lastSyncedAt: Date | null;
    /** Check 16 P1: working mailboxes not checked within STALE_SYNC_MS (the owner's own line). */
    stale: number;
    /** The oldest last check among the stale ones (null = never checked). */
    oldestStaleSyncAt: Date | null;
    /** Still on their first read more than FIRST_READ_STUCK_MS after connecting. */
    stuckFirstRead: number;
    /** The newest sync problem code (access_lost / rate_limited / sync_failed), never text. */
    errorCode: string | null;
  };
  drafts: { pending: number; sentLast7Days: number; createdThisMonth: number };
  ai: { callsToday: number; callsThisMonth: number; costCentsThisMonth: number };
  /** When each part of the pipeline last did something for this account. */
  health: { lastSortedAt: Date | null; lastDraftAt: Date | null; lastDigestAt: Date | null };
  /**
   * Plan #47: the referrer's business name (nothing else about them; only while referrals are
   * on), and this account's referral credits still waiting or refused by Stripe (always, so
   * money owed never disappears from /admin when the switch goes off).
   */
  referredByName: string | null;
  referralCredits: { waiting: number; failed: number; lastErrorCode: string | null };
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
    hasSubscription: sql<boolean>`${workspaces.stripeSubscriptionId} is not null`,
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

  // Check 16 P1: one row per mailbox (states, times and a fixed code only — never the address),
  // folded per workspace below with the same rule systemHealth uses.
  const boxRows = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      status: mailboxes.status,
      planPausedAt: mailboxes.planPausedAt,
      lastSyncedAt: mailboxes.lastSyncedAt,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      createdAt: mailboxes.createdAt,
      lastSyncErrorCode: mailboxes.lastSyncErrorCode,
      lastSyncErrorAt: mailboxes.lastSyncErrorAt,
    })
    .from(mailboxes)
    .where(inArray(mailboxes.workspaceId, ids));
  const wsById = new Map(ws.map((w) => [w.id, w]));
  const grouped = new Map<string, typeof boxRows>();
  for (const r of boxRows) grouped.set(r.workspaceId, [...(grouped.get(r.workspaceId) ?? []), r]);
  const boxes = [...grouped].map(([workspaceId, list]) => {
    const w = wsById.get(workspaceId)!;
    const trouble = list.map((r) => ({ r, t: mailboxTrouble(r, w, now) }));
    const stale = trouble.filter((x) => x.t.stale).map((x) => x.r);
    const coded = trouble
      .filter((x) => x.t.watched && x.r.lastSyncErrorCode)
      .map((x) => x.r)
      .sort((a, b) => (b.lastSyncErrorAt?.getTime() ?? 0) - (a.lastSyncErrorAt?.getTime() ?? 0));
    return {
      workspaceId,
      total: list.length,
      needReconnect: list.filter((r) => r.status === "reconnect_needed").length,
      lastSyncedAt: list.reduce<Date | null>(
        (a, r) => (r.lastSyncedAt && (!a || r.lastSyncedAt > a) ? r.lastSyncedAt : a),
        null,
      ),
      stale: stale.length,
      oldestStaleSyncAt: stale.some((r) => !r.lastSyncedAt)
        ? null
        : stale.reduce<Date | null>(
            (a, r) => (r.lastSyncedAt && (!a || r.lastSyncedAt < a) ? r.lastSyncedAt : a),
            null,
          ),
      stuckFirstRead: trouble.filter((x) => x.t.stuckFirstRead).length,
      errorCode: coded[0]?.lastSyncErrorCode ?? null,
    };
  });

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
  const referrals = referralsVisible();
  const referrer = alias(workspaces, "referrer");
  const referredBy = referrals
    ? await db()
        .select({ workspaceId: workspaces.id, name: referrer.businessName })
        .from(workspaces)
        .innerJoin(referrer, eq(referrer.id, workspaces.referredByWorkspaceId))
        .where(inArray(workspaces.id, ids))
    : [];
  // Credits still waiting or refused by Stripe show whatever the switch says now: they're
  // money owed (or a fix needed in Stripe) even if referrals were switched off since.
  const credits = await db()
    .select({
      workspaceId: referralCredits.beneficiaryWorkspaceId,
      waiting: sql<number>`count(*) filter (where ${referralCredits.status} = 'pending')::int`,
      failed: sql<number>`count(*) filter (where ${referralCredits.status} = 'failed')::int`,
      // The most recently created refused credit's code (not an alphabetical max).
      lastErrorCode: sql<
        string | null
      >`(array_agg(${referralCredits.lastErrorCode} order by ${referralCredits.createdAt} desc, ${referralCredits.id} desc) filter (where ${referralCredits.status} = 'failed'))[1]`,
    })
    .from(referralCredits)
    .where(
      and(
        inArray(referralCredits.beneficiaryWorkspaceId, ids),
        inArray(referralCredits.status, ["pending", "failed"]),
      ),
    )
    .groupBy(referralCredits.beneficiaryWorkspaceId);

  const digests = await db()
    .select({ workspaceId: activityLog.workspaceId, at: max(activityLog.createdAt) })
    .from(activityLog)
    .where(and(inArray(activityLog.workspaceId, ids), eq(activityLog.action, "digest_sent")))
    .groupBy(activityLog.workspaceId);

  const twoPlans = await workspacesWithTwoPlans(ids);

  const by = <T extends { workspaceId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.workspaceId, r]));
  const b = by(boxes);
  const d = by(draftCounts);
  const m = by(month);
  const hs = by(sorted);
  const hd = by(drafted);
  const hg = by(digests);
  const rb = by(referredBy);
  const rc = new Map(credits.map((c) => [c.workspaceId, c]));

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
    hasSubscription: Boolean(w.hasSubscription),
    twoLivePlans: twoPlans.has(w.id),
    createdAt: w.createdAt,
    mailboxes: {
      total: b.get(w.id)?.total ?? 0,
      needReconnect: b.get(w.id)?.needReconnect ?? 0,
      lastSyncedAt: b.get(w.id)?.lastSyncedAt ?? null,
      stale: b.get(w.id)?.stale ?? 0,
      oldestStaleSyncAt: b.get(w.id)?.oldestStaleSyncAt ?? null,
      stuckFirstRead: b.get(w.id)?.stuckFirstRead ?? 0,
      errorCode: b.get(w.id)?.errorCode ?? null,
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
    referredByName: rb.get(w.id) ? (rb.get(w.id)!.name ?? "a business with no name yet") : null,
    referralCredits: {
      waiting: rc.get(w.id)?.waiting ?? 0,
      failed: rc.get(w.id)?.failed ?? 0,
      lastErrorCode: rc.get(w.id)?.failed ? (rc.get(w.id)?.lastErrorCode ?? null) : null,
    },
  }));
}

/** The 5-minute poll syncs every working mailbox; much older than that means jobs stopped. */
export const JOBS_STALE_AFTER_MS = 20 * 60 * 1000;

/** Check 16 P1: a first read (the 30-day backfill) still going after this looks stuck. */
export const FIRST_READ_STUCK_MS = 2 * 60 * 60 * 1000;

/**
 * Check 16 P1: is this one mailbox stuck? Only mailboxes we're meant to be reading count: on
 * (not lost, not plan-paused) in an account whose jobs run. `stale` uses the owner's own
 * STALE_SYNC_MS, so /admin flags it in the same 30 minutes Settings tells the owner to wait.
 */
export function mailboxTrouble(
  m: {
    status: string;
    planPausedAt: Date | null;
    lastSyncedAt: Date | null;
    backfillCompletedAt: Date | null;
    createdAt: Date;
  },
  workspace: Parameters<typeof jobsAllowed>[0],
  now: Date,
): { watched: boolean; stale: boolean; stuckFirstRead: boolean } {
  const watched = mailboxOn(m) && jobsAllowed(workspace, now);
  return {
    watched,
    stale:
      watched &&
      !!m.backfillCompletedAt &&
      (!m.lastSyncedAt || now.getTime() - m.lastSyncedAt.getTime() > STALE_SYNC_MS),
    stuckFirstRead:
      watched &&
      !m.backfillCompletedAt &&
      now.getTime() - m.createdAt.getTime() > FIRST_READ_STUCK_MS,
  };
}

/**
 * App-wide health for the top of /admin: are background jobs running, and how
 * many mailboxes need their owner to reconnect, are stale or stuck on a first read. Counts only.
 */
export async function systemHealth(now: Date = new Date()) {
  const rows = await db()
    .select({
      status: mailboxes.status,
      planPausedAt: mailboxes.planPausedAt,
      lastSyncedAt: mailboxes.lastSyncedAt,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      createdAt: mailboxes.createdAt,
      workspace: { status: workspaces.status, evaluationEndsAt: workspaces.evaluationEndsAt },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId));
  // A plan-paused address isn't synced on purpose, so it never says "jobs look stopped".
  const working = rows.filter(
    (r) => mailboxOn(r) && r.backfillCompletedAt && jobsAllowed(r.workspace, now),
  );
  const newest = working.reduce<Date | null>(
    (a, r) => (r.lastSyncedAt && (!a || r.lastSyncedAt > a) ? r.lastSyncedAt : a),
    null,
  );
  const trouble = rows.map((r) => mailboxTrouble(r, r.workspace, now));
  return {
    workingMailboxes: working.length,
    needReconnect: rows.filter((r) => r.status === "reconnect_needed").length,
    lastSyncAt: newest,
    jobsLookStopped:
      working.length > 0 && (!newest || now.getTime() - newest.getTime() > JOBS_STALE_AFTER_MS),
    staleMailboxes: trouble.filter((t) => t.stale).length,
    stuckFirstReads: trouble.filter((t) => t.stuckFirstRead).length,
  };
}

export type Trade = (typeof tradeEnum.enumValues)[number];

/** Invite an owner (replaces `pnpm invite` for day-to-day use). Idempotent. */
export async function inviteOwner(input: {
  email: string;
  trade?: Trade | null;
  note?: string | null;
  /** Plan #47: the workspace whose referral link they came from (only while referrals are on). */
  referredByWorkspaceId?: string | null;
}) {
  const email = normalizeEmail(input.email);
  const [row] = await db()
    .insert(invites)
    .values({
      email,
      trade: input.trade ?? null,
      note: input.note?.trim() || null,
      referredByWorkspaceId: input.referredByWorkspaceId ?? null,
    })
    .onConflictDoNothing()
    .returning({ email: invites.email });
  return row ? "invited" : "already_invited";
}

/**
 * Round 2 (FW A4): Davi ticked "Added as a Google test user" for this invite. While the Google
 * app is in Testing, an owner who isn't a test user can't connect Gmail.
 */
export async function markTestUserAdded(email: string, now: Date = new Date()) {
  const rows = await db()
    .update(invites)
    .set({ testUserAddedAt: now })
    .where(eq(invites.email, normalizeEmail(email)))
    .returning({ email: invites.email });
  return rows.length > 0;
}

export async function listInvites() {
  return db()
    .select({
      email: invites.email,
      trade: invites.trade,
      invitedAt: invites.invitedAt,
      acceptedAt: invites.acceptedAt,
      testUserAddedAt: invites.testUserAddedAt,
    })
    .from(invites)
    .orderBy(desc(invites.invitedAt))
    .limit(ADMIN_PAGE_SIZE);
}
