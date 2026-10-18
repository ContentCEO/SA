import "server-only";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  max,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { utcDay } from "@/ai/usage";
import { jobExecutionsThisMonth } from "./job-runs";
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
  waitlist,
  workspaces,
} from "@/db/schema";
import { mailboxOn } from "./mailbox-plan-rules";
import { mailboxHealth, STALE_SYNC_MS } from "./mailbox-health";
import { SUPPORT_DETAIL_KEYS, type SupportActivity } from "./admin-rules";
import { normalizeEmail } from "./accounts";
import { effectiveStatus, jobsAllowed } from "./lifecycle";
import {
  adminFreeMonthLines,
  adminPlanLabel,
  referralsVisible,
  type AdminRewardRow,
} from "./referral-rules";
import { stripeKeyMode } from "./billing-rules";
import { stripeWaitingWorkspaces, workspacesWithTwoPlans } from "./billing";
import { CHECKOUT_NOTICE_ACTIONS } from "./billing-notice-rules";
import { moneyEventsFor } from "./stripe-money";
import type { MoneyEventRow } from "./stripe-money-rules";

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
  /** Plan #47: the billed plan's name, plus the free one while a free month runs. */
  planLabel: string;
  evaluationEndsAt: Date | null;
  setupPaidAt: Date | null;
  setupPaidVia: "stripe" | "house" | null;
  /** Check 17 P2: Stripe has a subscription on file (never the id itself). */
  hasSubscription: boolean;
  /** Check 17 P4: Stripe has two live plans for this account (one should be canceled there). */
  twoLivePlans: boolean;
  /** Check 17 P5: the newest checkout finished with nothing charged; Davi decides in Stripe. */
  checkoutNeedsReview: boolean;
  /** Check 17 P8: refunds and card disputes recorded from Stripe (amounts and dates only). */
  moneyEvents: MoneyEventRow[];
  /** Check 17 P9: the owner paid, but no Stripe notice arrived. */
  waitingOnStripe: boolean;
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
   * on), and this account's free months in plain lines: waiting (and why), booked, running,
   * refused or used early, and the latest flag (always, so an earned month never disappears
   * from /admin when the switch goes off). Counts, dates, plan names and fixed codes only.
   */
  referredByName: string | null;
  freeMonths: string[];
  createdAt: Date;
};

/**
 * Operational health only. Deliberately selects no thread, message or draft
 * text, subjects, or customer addresses — just counts, statuses and money.
 */
export const ADMIN_PAGE_SIZE = 50;

/**
 * Check 16 P5: the find box matches the business name or the owner's sign-in email, part of
 * either, any case; `%`, `_` and `\` are taken literally. Never logged (it can hold an email).
 */
export function accountSearch(q: string | null | undefined): SQL | undefined {
  const text = q?.trim().slice(0, 200);
  if (!text) return undefined;
  const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
  return or(ilike(workspaces.businessName, pattern), ilike(users.email, pattern));
}

/** 1-based page number from a query value; anything odd is page 1. */
export function pageNumber(v: unknown): number {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : 1;
  return n >= 1 ? n : 1;
}

export async function countWorkspaces(q?: string | null): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(accountSearch(q));
  return row?.n ?? 0;
}

/**
 * Newest accounts first, `ADMIN_PAGE_SIZE` per page (Check 16 P5: `page` is 1-based, `q` finds a
 * shop by name or email). Davi's own account is pinned first on page 1.
 */
export async function adminOverview(
  now: Date = new Date(),
  opts: { q?: string | null; page?: number; id?: string } = {},
): Promise<AdminRow[]> {
  const page = opts.page && opts.page > 1 ? Math.floor(opts.page) : 1;
  const search = opts.id ? eq(workspaces.id, opts.id) : accountSearch(opts.q);
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
    freePlan: workspaces.freePlan,
    freePlanUntil: workspaces.freePlanUntil,
    stripeSubscriptionId: workspaces.stripeSubscriptionId,
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
    .where(search)
    .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
    .limit(ADMIN_PAGE_SIZE)
    .offset((page - 1) * ADMIN_PAGE_SIZE);
  // Davi's own account is shown first on page 1, however many newer accounts there are.
  const adminEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : null;
  const own =
    adminEmail && page === 1 && !opts.id
      ? await db()
          .select(columns)
          .from(workspaces)
          .innerJoin(users, eq(users.id, workspaces.ownerUserId))
          .where(and(eq(users.email, adminEmail), search))
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
  // Free months show whatever the switch says now: an earned month is owed (or a fix is
  // needed in Stripe) even if referrals were switched off since. Done rows only for a flag.
  const rewardRows = await db()
    .select({
      workspaceId: referralCredits.beneficiaryWorkspaceId,
      status: referralCredits.status,
      stripeMode: referralCredits.stripeMode,
      startsAt: referralCredits.startsAt,
      endsAt: referralCredits.endsAt,
      freePlan: referralCredits.freePlan,
      keptAt: referralCredits.keptAt,
      attempts: referralCredits.attempts,
      lastErrorCode: referralCredits.lastErrorCode,
      adminFlag: referralCredits.adminFlag,
      flaggedAt: referralCredits.flaggedAt,
    })
    .from(referralCredits)
    .where(
      and(
        inArray(referralCredits.beneficiaryWorkspaceId, ids),
        sql`(${referralCredits.status} in ('pending', 'scheduled', 'running', 'failed') or ${referralCredits.adminFlag} is not null)`,
      ),
    )
    .orderBy(referralCredits.createdAt, referralCredits.id);
  const rewardsBy = new Map<string, AdminRewardRow[]>();
  for (const r of rewardRows) {
    if (!r.workspaceId) continue;
    rewardsBy.set(r.workspaceId, [...(rewardsBy.get(r.workspaceId) ?? []), r]);
  }
  const keyMode = stripeKeyMode(process.env.STRIPE_SECRET_KEY);

  const digests = await db()
    .select({ workspaceId: activityLog.workspaceId, at: max(activityLog.createdAt) })
    .from(activityLog)
    .where(and(inArray(activityLog.workspaceId, ids), eq(activityLog.action, "digest_sent")))
    .groupBy(activityLog.workspaceId);

  const twoPlans = await workspacesWithTwoPlans(ids);
  const money = await moneyEventsFor(ids);
  const waitingOnStripe = await stripeWaitingWorkspaces();
  const notices = await db()
    .select({
      workspaceId: activityLog.workspaceId,
      latest: sql<string>`(array_agg(${activityLog.action} order by ${activityLog.createdAt} desc, ${activityLog.id} desc))[1]`,
    })
    .from(activityLog)
    .where(
      and(
        inArray(activityLog.workspaceId, ids),
        inArray(activityLog.action, [...CHECKOUT_NOTICE_ACTIONS]),
      ),
    )
    .groupBy(activityLog.workspaceId);
  const reviews = new Set(
    notices.filter((n) => n.latest === "checkout_needs_review").map((n) => n.workspaceId),
  );

  const by = <T extends { workspaceId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.workspaceId, r]));
  const b = by(boxes);
  const d = by(draftCounts);
  const m = by(month);
  const hs = by(sorted);
  const hd = by(drafted);
  const hg = by(digests);
  const rb = by(referredBy);

  return ws.map((w) => ({
    workspaceId: w.id,
    ownerEmail: w.ownerEmail,
    businessName: w.businessName,
    trade: w.trade,
    status: effectiveStatus(w, now),
    storedStatus: w.status,
    plan: w.plan,
    planLabel: adminPlanLabel(w, now),
    evaluationEndsAt: w.evaluationEndsAt,
    setupPaidAt: w.setupPaidAt,
    setupPaidVia: w.setupPaidVia,
    hasSubscription: Boolean(w.hasSubscription),
    twoLivePlans: twoPlans.has(w.id),
    checkoutNeedsReview: reviews.has(w.id),
    moneyEvents: money.get(w.id) ?? [],
    waitingOnStripe: waitingOnStripe.has(w.id),
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
    freeMonths: adminFreeMonthLines(w, rewardsBy.get(w.id) ?? [], keyMode, now),
  }));
}

/**
 * Check 16 P3: account counts for the "Needs you" box, across every account (not just the page
 * shown). Counts only.
 */
export async function accountsNeedingYou(now: Date = new Date()) {
  const soon = new Date(now.getTime() + 24 * 3_600_000);
  const [row] = await db()
    .select({
      pastDue: sql<number>`count(*) filter (where ${workspaces.status} = 'past_due')::int`,
      trialsEnding: sql<number>`count(*) filter (where ${workspaces.status} = 'evaluating' and ${workspaces.evaluationEndsAt} > ${now.toISOString()}::timestamptz and ${workspaces.evaluationEndsAt} <= ${soon.toISOString()}::timestamptz)::int`,
    })
    .from(workspaces);
  return { paymentsFailed: row?.pastDue ?? 0, trialsEndingSoon: row?.trialsEnding ?? 0 };
}

/**
 * Check 16 P8: the support page for one account — its admin row, the Gmail lines the owner sees,
 * and the last 50 activity rows with only fixed detail keys. Never a thread id, never a join to
 * threads, messages or drafts, never a mailbox address. Null for an unknown id.
 */
export async function supportView(workspaceId: string, now: Date = new Date()) {
  const [row] = await adminOverview(now, { id: workspaceId });
  if (!row) return null;
  const boxes = await db()
    .select({
      status: mailboxes.status,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      lastSyncedAt: mailboxes.lastSyncedAt,
      watchExpiresAt: mailboxes.watchExpiresAt,
      lastSyncErrorCode: mailboxes.lastSyncErrorCode,
      planPausedAt: mailboxes.planPausedAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId))
    .orderBy(mailboxes.createdAt);
  const push = Boolean(process.env.GMAIL_PUBSUB_TOPIC);
  const gmail = boxes.map((m, i) => ({
    label: `Inbox ${i + 1}`,
    lines: m.planPausedAt
      ? [{ label: "Plan", text: "Paused: their plan covers fewer inboxes.", problem: false }]
      : mailboxHealth(m, now, push).lines,
  }));
  const picked = sql<SupportActivity["detail"]>`jsonb_strip_nulls(jsonb_build_object(${sql.raw(
    SUPPORT_DETAIL_KEYS.map((k) => `'${k}', ${activityLog.detail.name}->'${k}'`).join(", "),
  )}))`;
  const activity = await db()
    .select({
      action: activityLog.action,
      actor: activityLog.actor,
      createdAt: activityLog.createdAt,
      detail: picked,
    })
    .from(activityLog)
    .where(eq(activityLog.workspaceId, workspaceId))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(50);
  return { row, gmail, activity: activity as SupportActivity[] };
}

/**
 * The 5-minute poll syncs every working mailbox; much older than that means jobs stopped. 25
 * minutes, not 20 (integrator, wave 2): with Gmail push on, the poll leaves a quiet inbox alone
 * for up to 15 minutes after its last sync (`PUSH_FRESH_MS`), so a healthy one can reach ~20.
 */
export const JOBS_STALE_AFTER_MS = 25 * 60 * 1000;

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
    // Check 25 P4: Inngest meters runs + steps; its free plan pauses at 50,000 a month.
    jobExecutionsThisMonth: await jobExecutionsThisMonth(now),
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
 * Check 16 P7: take back an invite before it's used — only while it was never accepted and no
 * account has that email. A waitlist entry it came from offers Invite again.
 */
export async function removeInvite(
  email: string,
): Promise<"removed" | "already_signed_in" | "not_found"> {
  const address = normalizeEmail(email);
  return db().transaction(async (tx) => {
    const [invite] = await tx
      .select({ acceptedAt: invites.acceptedAt })
      .from(invites)
      .where(eq(invites.email, address))
      .for("update");
    if (!invite) return "not_found";
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${address}`);
    if (invite.acceptedAt || user) return "already_signed_in";
    await tx.delete(invites).where(and(eq(invites.email, address), isNull(invites.acceptedAt)));
    await tx
      .update(waitlist)
      .set({ invitedAt: null })
      .where(sql`lower(${waitlist.email}) = ${address}`);
    return "removed";
  });
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

export async function countInvites(): Promise<number> {
  const [row] = await db().select({ n: count() }).from(invites);
  return row?.n ?? 0;
}

/** Newest invites first, `ADMIN_PAGE_SIZE` per page (Check 16 P5: `page` is 1-based). */
export async function listInvites(opts: { page?: number } = {}) {
  const page = opts.page && opts.page > 1 ? Math.floor(opts.page) : 1;
  return db()
    .select({
      email: invites.email,
      trade: invites.trade,
      invitedAt: invites.invitedAt,
      acceptedAt: invites.acceptedAt,
      testUserAddedAt: invites.testUserAddedAt,
      // Check 16 P9: Gmail connected proves Google let them in as a test user.
      gmailConnected: sql<boolean>`exists (
        select 1 from mailboxes m
        join workspaces w on w.id = m.workspace_id
        join users u on u.id = w.owner_user_id
        where lower(u.email) = lower("invites"."email")
      )`,
    })
    .from(invites)
    .orderBy(desc(invites.invitedAt), invites.email)
    .limit(ADMIN_PAGE_SIZE)
    .offset((page - 1) * ADMIN_PAGE_SIZE);
}
