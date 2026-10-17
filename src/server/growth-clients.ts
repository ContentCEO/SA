import "server-only";
import { createHmac } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { growthServicesFrom, type GrowthService } from "@/config/growth";
import { siteConfig } from "@/config/site";
import type { Trade } from "@/config/trades";
import { db } from "@/db";
import {
  appSettings,
  growthClients,
  growthMonthly,
  growthUpdates,
  invites,
  users,
  waitlist,
  workspaces,
  type GrowthClient,
} from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendEmail, type EmailSender } from "@/lib/email";
import { brandEmail } from "@/lib/email-layout";
import {
  adminToday,
  canStartGrowth,
  checkInEmpty,
  growthInviteEmailCopy,
  growthMoveTarget,
  growthUpdateEmailCopy,
  localDayStart,
  monthKeyOf,
  periodMetrics,
  portalOpen,
  sumCheckIns,
  type CheckInNumbers,
  type GrowthMove,
  type GrowthStatus,
} from "./growth-client-rules";
import { describeWaitlistEntry, GROWTH_ONLY_TEAM_SIZE, withoutGrowthBlocks } from "./growth-note";
import { localMonthName, usableTimeZone } from "./snooze-rules";

/**
 * Squared Away Growth clients (Davi, 2026-10-16): an account Davi does Growth work for, its
 * updates and the numbers Davi enters after each monthly check-in. Growth never uses inbox
 * data: nothing here reads mailboxes, threads, messages, drafts or the business profile, and
 * nothing here goes to the AI. Davi's admin actions call these after
 * requireAdmin(); the dashboard after requireOwner() and portalOpen().
 */

/** Same rule as normalizeEmail (accounts.ts, which imports this file at sign-in). */
const norm = (email: string) => email.trim().toLowerCase();

export async function growthClientFor(workspaceId: string): Promise<GrowthClient | null> {
  const [c] = await db()
    .select()
    .from(growthClients)
    .where(eq(growthClients.workspaceId, workspaceId));
  return c ?? null;
}

/** The client whose dashboard this workspace may open (active or paused), else null. */
export async function portalClient(workspaceId: string): Promise<GrowthClient | null> {
  const c = await growthClientFor(workspaceId);
  return c && portalOpen(c.status) ? c : null;
}

// ---------------------------------------------------------------------------------------------
// Invites: "Invite to Growth" for someone with no account yet.

/**
 * At sign-in (ensureUserAndWorkspace): a pending "Invite to Growth" on this address makes the
 * account a Growth client, then the invite's Growth fields are cleared (used once). An account
 * that is already a client keeps its row as it is. Never touches the app's trial clock.
 */
export async function linkGrowthInvite(
  email: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<"linked" | "none"> {
  const address = norm(email);
  return db().transaction(async (tx) => {
    const [invite] = await tx
      .select({
        services: invites.growthServices,
        startedOn: invites.growthStartedOn,
      })
      .from(invites)
      .where(and(eq(invites.email, address), isNotNull(invites.growthInvitedAt)))
      .for("update");
    if (!invite) return "none";
    await tx
      .insert(growthClients)
      .values({
        workspaceId,
        status: "active",
        startedOn: invite.startedOn ?? adminToday(now),
        services: growthServicesFrom(invite.services ?? []),
      })
      .onConflictDoNothing({ target: growthClients.workspaceId });
    await tx
      .update(invites)
      .set({ growthInvitedAt: null, growthServices: null, growthStartedOn: null })
      .where(eq(invites.email, address));
    return "linked";
  });
}

export type GrowthInviteResult = "invited" | "updated" | "has_account";

/**
 * Davi's "Invite to Growth": lets this address sign in (the invite list is the sign-in gate)
 * and marks the invite so the first sign-in makes the account a Growth client. Someone who
 * already has an account is refused (use "Start Growth for this account" instead). Tapping it
 * again only changes the services and the start date. It starts no trial: that still begins
 * only when Gmail is connected.
 */
export async function inviteToGrowth(
  input: { email: string; services: GrowthService[]; startedOn: string; trade?: Trade | null },
  now: Date = new Date(),
): Promise<GrowthInviteResult> {
  const address = norm(input.email);
  const [account] = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${address}`);
  if (account) return "has_account";
  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ acceptedAt: invites.acceptedAt, growthInvitedAt: invites.growthInvitedAt })
      .from(invites)
      .where(eq(invites.email, address))
      .for("update");
    if (existing?.acceptedAt) return "has_account";
    const growth = {
      growthServices: input.services,
      growthStartedOn: input.startedOn,
    };
    if (!existing) {
      await tx
        .insert(invites)
        .values({ email: address, trade: input.trade ?? null, growthInvitedAt: now, ...growth });
      return "invited";
    }
    await tx
      .update(invites)
      .set({ growthInvitedAt: existing.growthInvitedAt ?? now, ...growth })
      .where(eq(invites.email, address));
    return existing.growthInvitedAt ? "updated" : "invited";
  });
}

function growthInviteKey(email: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "")
    .update(`growth:${norm(email)}`)
    .digest("hex")
    .slice(0, 16);
}

export type GrowthEmailOutcome = "sent" | "already_sent" | "not_configured" | "skipped" | "failed";

/**
 * "Your Squared Away Growth dashboard" with the sign-in link, once per Growth invite. Never
 * throws: a failed email never fails the invite. Logs the error's name only.
 */
export async function sendGrowthInviteEmail(
  email: string,
  deps: { send?: EmailSender } = {},
): Promise<GrowthEmailOutcome> {
  try {
    const address = norm(email);
    const [invite] = await db()
      .select({ growthInvitedAt: invites.growthInvitedAt, acceptedAt: invites.acceptedAt })
      .from(invites)
      .where(eq(invites.email, address));
    if (!invite?.growthInvitedAt || invite.acceptedAt) return "skipped";
    const id = `${growthInviteKey(address)}-${invite.growthInvitedAt.getTime()}`;
    const marker = `growth-invite-email:${id}`;
    const [seen] = await db().select().from(appSettings).where(eq(appSettings.key, marker));
    if (seen) return "already_sent";
    const c = growthInviteEmailCopy({ signInUrl: appUrl("/signin"), phone: siteConfig.phone });
    const { text, html } = brandEmail(c);
    const outcome = await (deps.send ?? sendEmail)({
      to: address,
      subject: c.subject,
      text,
      html,
      idempotencyKey: `growth-invite-${id}`,
    });
    if (outcome === "not_configured") return "not_configured";
    await db()
      .insert(appSettings)
      .values({ key: marker, value: new Date().toISOString() })
      .onConflictDoNothing();
    return outcome;
  } catch (err) {
    console.error("growth_invite_email_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }
}

// ---------------------------------------------------------------------------------------------
// Davi's moves on a client.

/** "Start Growth for this account": a new client, or a client whose Growth had ended. */
export async function startGrowth(input: {
  workspaceId: string;
  services: GrowthService[];
  startedOn: string;
  timeZone: string;
}): Promise<"started" | "restarted" | "already" | "not_found"> {
  return db().transaction(async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    if (!ws) return "not_found";
    const [existing] = await tx
      .select({ id: growthClients.id, status: growthClients.status })
      .from(growthClients)
      .where(eq(growthClients.workspaceId, input.workspaceId))
      .for("update");
    if (existing && !canStartGrowth(existing.status)) return "already";
    const fields = {
      status: "active" as const,
      startedOn: input.startedOn,
      services: input.services,
      timeZone: input.timeZone,
      endedAt: null,
    };
    if (existing) {
      await tx.update(growthClients).set(fields).where(eq(growthClients.id, existing.id));
      return "restarted";
    }
    const made = await tx
      .insert(growthClients)
      .values({ workspaceId: input.workspaceId, ...fields })
      .onConflictDoNothing({ target: growthClients.workspaceId })
      .returning({ id: growthClients.id });
    return made.length ? "started" : "already";
  });
}

/** Change a client's services, start date and time zone. */
export async function changeGrowth(input: {
  clientId: string;
  services: GrowthService[];
  startedOn: string;
  timeZone: string;
}): Promise<boolean> {
  const rows = await db()
    .update(growthClients)
    .set({ services: input.services, startedOn: input.startedOn, timeZone: input.timeZone })
    .where(eq(growthClients.id, input.clientId))
    .returning({ id: growthClients.id });
  return rows.length > 0;
}

/** Pause, resume or end. Only the moves `growthMoveTarget` allows from where the client is. */
export async function moveGrowthClient(
  clientId: string,
  move: GrowthMove,
  now: Date = new Date(),
): Promise<"ok" | "not_allowed" | "not_found"> {
  return db().transaction(async (tx) => {
    const [c] = await tx
      .select({ status: growthClients.status })
      .from(growthClients)
      .where(eq(growthClients.id, clientId))
      .for("update");
    if (!c) return "not_found";
    const to = growthMoveTarget(c.status as GrowthStatus, move);
    if (!to) return "not_allowed";
    await tx
      .update(growthClients)
      .set({ status: to, ...(to === "ended" ? { endedAt: now } : {}) })
      .where(eq(growthClients.id, clientId));
    return "ok";
  });
}

/** Post an update (Davi's own words). Not for a client whose Growth has ended. */
export async function postGrowthUpdate(
  clientId: string,
  update: { title: string; body: string },
  now: Date = new Date(),
): Promise<{ status: "posted"; updateId: string } | { status: "ended" | "not_found" }> {
  const c = await db()
    .select({ status: growthClients.status })
    .from(growthClients)
    .where(eq(growthClients.id, clientId));
  if (!c[0]) return { status: "not_found" };
  if (c[0].status === "ended") return { status: "ended" };
  const [row] = await db()
    .insert(growthUpdates)
    .values({ growthClientId: clientId, postedAt: now, title: update.title, body: update.body })
    .returning({ id: growthUpdates.id });
  return { status: "posted", updateId: row!.id };
}

/**
 * "New update from Squared Away Growth" to the client: the title (Davi's words) and a link to
 * the dashboard, nothing else. Once per update: `notified_at` is set only after Resend took it
 * (idempotency key per update, so a retry within Resend's window never sends twice). Without
 * Resend set up nothing is sent and nothing is marked. Never throws; logs the error's name.
 */
export async function notifyGrowthUpdate(
  updateId: string,
  deps: { send?: EmailSender; now?: Date } = {},
): Promise<GrowthEmailOutcome> {
  try {
    const [row] = await db()
      .select({
        id: growthUpdates.id,
        title: growthUpdates.title,
        notifiedAt: growthUpdates.notifiedAt,
        workspaceId: growthClients.workspaceId,
        to: users.email,
      })
      .from(growthUpdates)
      .innerJoin(growthClients, eq(growthClients.id, growthUpdates.growthClientId))
      .innerJoin(workspaces, eq(workspaces.id, growthClients.workspaceId))
      .innerJoin(users, eq(users.id, workspaces.ownerUserId))
      .where(eq(growthUpdates.id, updateId));
    if (!row || row.notifiedAt) return "skipped";
    const c = growthUpdateEmailCopy({
      title: row.title,
      dashboardUrl: appUrl("/my-growth"),
      phone: siteConfig.phone,
    });
    const { text, html } = brandEmail(c);
    const outcome = await (deps.send ?? sendEmail)({
      to: row.to,
      subject: c.subject,
      text,
      html,
      idempotencyKey: `growth-update-${row.workspaceId}-${row.id}`,
    });
    if (outcome === "not_configured") return "not_configured";
    await db()
      .update(growthUpdates)
      .set({ notifiedAt: deps.now ?? new Date() })
      .where(and(eq(growthUpdates.id, row.id), isNull(growthUpdates.notifiedAt)));
    return outcome;
  } catch (err) {
    console.error("growth_update_email_failed", {
      updateId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }
}

/** One month's check-in numbers: saved, or removed when the form was emptied. */
export async function saveGrowthMonth(
  clientId: string,
  month: string,
  numbers: CheckInNumbers,
  note: string | null,
  now: Date = new Date(),
): Promise<"saved" | "cleared" | "not_found"> {
  const [c] = await db()
    .select({ id: growthClients.id })
    .from(growthClients)
    .where(eq(growthClients.id, clientId));
  if (!c) return "not_found";
  if (checkInEmpty(numbers, note)) {
    await db()
      .delete(growthMonthly)
      .where(and(eq(growthMonthly.growthClientId, clientId), eq(growthMonthly.month, month)));
    return "cleared";
  }
  const values = { ...numbers, note, updatedAt: now };
  await db()
    .insert(growthMonthly)
    .values({ growthClientId: clientId, month, ...values })
    .onConflictDoUpdate({
      target: [growthMonthly.growthClientId, growthMonthly.month],
      set: values,
    });
  return "saved";
}

/**
 * Davi's "Remove" on a waitlist card (2026-10-16), decided on the row as it is now: a row that
 * exists only for Growth is deleted; on an app sign-up only the Growth block goes (the app
 * sign-up and its own note stay). Content-free log.
 */
export async function removeGrowthRequest(
  email: string,
): Promise<"deleted" | "block_removed" | "no_request" | "not_found"> {
  const result = await db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, norm(email)))
      .for("update");
    if (!row) return "not_found" as const;
    const facts = describeWaitlistEntry(row);
    if (!facts.app) {
      await tx
        .delete(waitlist)
        .where(and(eq(waitlist.email, row.email), eq(waitlist.teamSize, GROWTH_ONLY_TEAM_SIZE)));
      return "deleted" as const;
    }
    if (facts.growth.length === 0) return "no_request" as const;
    await tx
      .update(waitlist)
      .set({ note: withoutGrowthBlocks(row.note) })
      .where(eq(waitlist.email, row.email));
    return "block_removed" as const;
  });
  console.info("growth_request_removed", { result });
  return result;
}

// ---------------------------------------------------------------------------------------------
// What /admin shows: only what Davi entered (no inbox data of any kind).

const STATUS_ORDER = sql`case ${growthClients.status} when 'active' then 0 when 'paused' then 1 else 2 end`;

export async function listGrowthAdmin() {
  const clients = await db()
    .select({
      client: growthClients,
      businessName: workspaces.businessName,
      ownerEmail: users.email,
    })
    .from(growthClients)
    .innerJoin(workspaces, eq(workspaces.id, growthClients.workspaceId))
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .orderBy(STATUS_ORDER, desc(growthClients.createdAt))
    .limit(100);
  const ids = clients.map((c) => c.client.id);
  const [updates, months, pending] = await Promise.all([
    ids.length
      ? db()
          .select({
            id: growthUpdates.id,
            growthClientId: growthUpdates.growthClientId,
            postedAt: growthUpdates.postedAt,
            title: growthUpdates.title,
            notifiedAt: growthUpdates.notifiedAt,
          })
          .from(growthUpdates)
          .where(inArray(growthUpdates.growthClientId, ids))
          .orderBy(desc(growthUpdates.postedAt), desc(growthUpdates.id))
      : [],
    ids.length
      ? db()
          .select()
          .from(growthMonthly)
          .where(inArray(growthMonthly.growthClientId, ids))
          .orderBy(desc(growthMonthly.month))
      : [],
    db()
      .select({
        email: invites.email,
        invitedAt: invites.growthInvitedAt,
        services: invites.growthServices,
        startedOn: invites.growthStartedOn,
      })
      .from(invites)
      .where(isNotNull(invites.growthInvitedAt))
      .orderBy(desc(invites.growthInvitedAt))
      .limit(50),
  ]);
  return {
    clients: clients.map((c) => ({
      ...c.client,
      label: c.businessName || c.ownerEmail,
      ownerEmail: c.ownerEmail,
      updates: updates.filter((u) => u.growthClientId === c.client.id).slice(0, 5),
      months: months.filter((m) => m.growthClientId === c.client.id).slice(0, 12),
    })),
    pending: pending.map((p) => ({ ...p, services: growthServicesFrom(p.services ?? []) })),
  };
}

/** Accounts "Start Growth for this account" offers: not a client yet, or Growth ended. */
export async function growthAccountChoices(limit = 200) {
  const rows = await db()
    .select({
      workspaceId: workspaces.id,
      businessName: workspaces.businessName,
      ownerEmail: users.email,
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(growthClients, eq(growthClients.workspaceId, workspaces.id))
    .where(or(isNull(growthClients.id), eq(growthClients.status, "ended")))
    .orderBy(desc(workspaces.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    label: r.businessName ? `${r.businessName} (${r.ownerEmail})` : r.ownerEmail,
  }));
}

/** For the waitlist cards: who already has a Growth invite waiting, or is a client. */
export async function growthStateForEmails(emails: string[]) {
  const list = [...new Set(emails.map(norm))];
  const out = new Map<string, { invitedAt: Date | null; client: GrowthStatus | null }>();
  if (list.length === 0) return out;
  const [pending, clients] = await Promise.all([
    db()
      .select({ email: invites.email, at: invites.growthInvitedAt })
      .from(invites)
      .where(and(inArray(invites.email, list), isNotNull(invites.growthInvitedAt))),
    db()
      .select({ email: sql<string>`lower(${users.email})`, status: growthClients.status })
      .from(growthClients)
      .innerJoin(workspaces, eq(workspaces.id, growthClients.workspaceId))
      .innerJoin(users, eq(users.id, workspaces.ownerUserId))
      .where(inArray(sql`lower(${users.email})`, list)),
  ]);
  for (const p of pending) out.set(p.email, { invitedAt: p.at, client: null });
  for (const c of clients)
    out.set(c.email, {
      invitedAt: out.get(c.email)?.invitedAt ?? null,
      client: c.status as GrowthStatus,
    });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The client's dashboard.

/**
 * Everything /my-growth shows, for this client only: Davi's monthly numbers, updates and the
 * services. Months are the client's own (growth_clients.time_zone). "Since you started" = the
 * months from the start date's month to now; "This month" = the client's current month.
 */
export async function growthDashboard(client: GrowthClient, now: Date = new Date()) {
  const timeZone = usableTimeZone(client.timeZone);
  const startsAt = localDayStart(client.startedOn, timeZone);
  const started = startsAt.getTime() <= now.getTime();
  const month = monthKeyOf(now, timeZone);
  const startMonth = client.startedOn.slice(0, 7);

  const [rows, updates] = await Promise.all([
    db()
      .select()
      .from(growthMonthly)
      .where(eq(growthMonthly.growthClientId, client.id))
      .orderBy(asc(growthMonthly.month)),
    db()
      .select({
        id: growthUpdates.id,
        postedAt: growthUpdates.postedAt,
        title: growthUpdates.title,
        body: growthUpdates.body,
      })
      .from(growthUpdates)
      .where(eq(growthUpdates.growthClientId, client.id))
      .orderBy(desc(growthUpdates.postedAt), desc(growthUpdates.id))
      .limit(50),
  ]);
  const sinceRows = started ? rows.filter((r) => r.month >= startMonth && r.month <= month) : [];
  const monthRows = started ? rows.filter((r) => r.month === month) : [];

  return {
    status: client.status as GrowthStatus,
    services: growthServicesFrom(client.services),
    startedOn: client.startedOn,
    started,
    timeZone,
    monthName: localMonthName(now, timeZone),
    since: { checkIns: sinceRows.length, metrics: periodMetrics("since", sumCheckIns(sinceRows)) },
    thisMonth: {
      checkIns: monthRows.length,
      metrics: periodMetrics("month", sumCheckIns(monthRows)),
    },
    updates,
  };
}

export type GrowthDashboard = Awaited<ReturnType<typeof growthDashboard>>;
