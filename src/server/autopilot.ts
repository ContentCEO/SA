import "server-only";
import { hasUnfilledGap } from "@/ai/gaps";
import { and, count, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { pricing } from "@/config/pricing";
import { db } from "@/db";
import {
  activityLog,
  drafts,
  mailboxes,
  messages,
  rules,
  threads,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { AUTO_DRAFT_CATEGORIES, sendDraft, type DraftDeps, type SendOutcome } from "./drafts";
import { effectiveStatus } from "./lifecycle";

/**
 * Autopilot: the owner's explicit exception to "nothing leaves without your
 * okay". Every rule here is enforced in code and has a test. Three layers:
 *
 * 1. Account: Crew or Company plan, and setup finished (status `active`).
 * 2. Category: the owner turned it on, and it has earned it — at least
 *    EARN_THRESHOLD drafts in that category approved without edits.
 * 3. Each email: never complaints, money, flagged threads, people the owner
 *    has never written to, follow-ups, or anything the checks were unsure of.
 *
 * Then a grace window: the reply sits in the queue for GRACE_MINUTES saying
 * when it will go, with "Hold it". Everything is checked again just before
 * sending.
 */
export const AUTOPILOT_CATEGORIES = AUTO_DRAFT_CATEGORIES;
export const EARN_THRESHOLD = 10;
export const MIN_CONFIDENCE_PCT = 85;
export const GRACE_MINUTES = 10;
export const DAILY_AUTOPILOT_CAP = 20;

type Category = (typeof AUTOPILOT_CATEGORIES)[number];
export function isAutopilotCategory(c: unknown): c is Category {
  return typeof c === "string" && (AUTOPILOT_CATEGORIES as readonly string[]).includes(c);
}

/** Layer 1. Returns why not, in plain words, or null when unlocked. */
export function accountLockReason(
  w: Pick<Workspace, "status" | "evaluationEndsAt" | "plan">,
  now: Date = new Date(),
): string | null {
  if (!w.plan || !pricing.plans[w.plan].autopilot) {
    return "Autopilot comes with the Crew and Company plans.";
  }
  if (effectiveStatus(w, now) !== "active") {
    return "Autopilot opens up once your setup call is done.";
  }
  return null;
}

export type GuardrailInput = {
  category: string | null;
  needsOwner: boolean;
  kind: "reply" | "followup";
  confidencePct: number | null;
  flags: string[];
  /** Dollar amounts the classifier found in the customer's email. */
  amountsInEmail: number[];
  draftBody: string;
  /** The owner has written to this address before (not just received from it). */
  knownCustomer: boolean;
  /** The email tried to instruct the assistant, or came from a building department. */
  untrusted?: boolean;
  municipal?: boolean;
};

/** Layer 3. Every reason this email must wait for the owner; empty = may go. */
export function guardrailReasons(g: GuardrailInput): string[] {
  const out: string[] = [];
  if (!isAutopilotCategory(g.category))
    out.push("Complaints and other emails always wait for you.");
  if (g.needsOwner) out.push("Flagged as needing you.");
  if (g.kind !== "reply") out.push("Follow-ups always wait for you.");
  if ((g.confidencePct ?? 0) < MIN_CONFIDENCE_PCT) out.push("Not confident enough to send alone.");
  if (g.flags.length) out.push("Has things to check before sending.");
  if (g.category === "invoice_payment" && g.amountsInEmail.length)
    out.push("Payments with an amount always wait for you.");
  if (/\$\s?\d/.test(g.draftBody)) out.push("Mentions money, so it waits for you.");
  if (hasUnfilledGap(g.draftBody)) out.push("Has gaps for you to fill in.");
  if (!g.knownCustomer) out.push("You haven't written to this person before.");
  if (g.untrusted) out.push("This email tried to give instructions to the assistant.");
  if (g.municipal) out.push("Building departments always wait for you.");
  return out;
}

async function knownCustomer(mailboxId: string, address: string | null, before: Date) {
  if (!address) return false;
  const [row] = await db()
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "out"),
        lt(messages.sentAt, before),
        sql`${messages.toAddresses} @> ${JSON.stringify([address.toLowerCase()])}::jsonb`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** Layer 2's evidence: replies in each category the owner sent exactly as drafted. */
export async function earnedCounts(workspaceId: string): Promise<Map<string, number>> {
  const rows = await db()
    .select({ category: threads.category, n: count() })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(drafts.kind, "reply"),
        eq(drafts.status, "sent"),
        sql`${drafts.sentGmailMessageId} is not null`,
      ),
    )
    .groupBy(threads.category);
  return new Map(rows.filter((r) => r.category).map((r) => [r.category!, r.n]));
}

async function modes(workspaceId: string) {
  const rows = await db().select().from(rules).where(eq(rules.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.category, r.mode]));
}

export type AutopilotState = {
  lockedReason: string | null;
  categories: { category: Category; on: boolean; earned: number; canTurnOn: boolean }[];
};

export async function autopilotState(
  workspace: Pick<Workspace, "id" | "status" | "evaluationEndsAt" | "plan">,
  now: Date = new Date(),
): Promise<AutopilotState> {
  const lockedReason = accountLockReason(workspace, now);
  const [earned, mode] = await Promise.all([earnedCounts(workspace.id), modes(workspace.id)]);
  return {
    lockedReason,
    categories: AUTOPILOT_CATEGORIES.map((category) => {
      const n = earned.get(category) ?? 0;
      return {
        category,
        on: !lockedReason && mode.get(category) === "autopilot",
        earned: n,
        canTurnOn: !lockedReason && n >= EARN_THRESHOLD,
      };
    }),
  };
}

export class AutopilotNotAllowedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AutopilotNotAllowedError";
  }
}

/** The owner's switch. Turning on is checked against layers 1 and 2; turning off always works. */
export async function setAutopilot(
  workspace: Pick<Workspace, "id" | "status" | "evaluationEndsAt" | "plan">,
  category: string,
  on: boolean,
  now: Date = new Date(),
) {
  if (!isAutopilotCategory(category))
    throw new AutopilotNotAllowedError("Not available for that kind of email.");
  if (on) {
    const locked = accountLockReason(workspace, now);
    if (locked) throw new AutopilotNotAllowedError(locked);
    const earned = (await earnedCounts(workspace.id)).get(category) ?? 0;
    if (earned < EARN_THRESHOLD)
      throw new AutopilotNotAllowedError(
        `Needs ${EARN_THRESHOLD - earned} more replies sent as drafted.`,
      );
  }
  const mode = on ? ("autopilot" as const) : ("draft" as const);
  await db()
    .insert(rules)
    .values({ workspaceId: workspace.id, category, mode, updatedAt: now })
    .onConflictDoUpdate({
      target: [rules.workspaceId, rules.category],
      set: { mode, updatedAt: now },
    });
  if (!on) {
    // Anything already counting down in that category waits for the owner instead.
    await db().execute(sql`
      update ${drafts} set auto_send_at = null
      where ${drafts.autoSendAt} is not null and ${drafts.status} = 'pending'
        and ${drafts.threadId} in (
          select ${threads.id} from ${threads}
          join ${mailboxes} on ${mailboxes.id} = ${threads.mailboxId}
          where ${mailboxes.workspaceId} = ${workspace.id} and ${threads.category} = ${category}
        )`);
  }
  await db().insert(activityLog).values({
    workspaceId: workspace.id,
    actor: "owner",
    action: "autopilot_changed",
    detail: { category, on },
  });
}

async function loadForAutopilot(draftId: string) {
  const [row] = await db()
    .select({ draft: drafts, thread: threads, mailbox: mailboxes, workspace: workspaces })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(drafts.id, draftId));
  return row;
}

async function sentByAutopilotToday(workspaceId: string, now: Date) {
  const since = new Date(now.getTime() - 86_400_000);
  const [row] = await db()
    .select({ n: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.workspaceId, workspaceId),
        eq(activityLog.action, "autopilot_scheduled"),
        gte(activityLog.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Every reason this draft can't go on its own right now (all three layers + the daily cap). */
async function blockers(row: NonNullable<Awaited<ReturnType<typeof loadForAutopilot>>>, now: Date) {
  const { draft, thread, mailbox, workspace } = row;
  const locked = accountLockReason(workspace, now);
  if (locked) return [locked];
  const mode = (await modes(workspace.id)).get(thread.category ?? "");
  if (mode !== "autopilot") return ["Autopilot is off for this kind of email."];
  const [customer] = await db()
    .select({ address: messages.fromAddress })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.direction, "in")))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const extracted = (thread.extracted ?? {}) as {
    dollar_amounts?: number[];
    injection?: boolean;
    municipal?: boolean;
  };
  return guardrailReasons({
    category: thread.category,
    needsOwner: thread.needsOwner || thread.needsOwnerManual,
    kind: draft.kind,
    confidencePct: draft.confidence,
    flags: draft.flags,
    amountsInEmail: extracted.dollar_amounts ?? [],
    untrusted: extracted.injection === true,
    municipal: extracted.municipal === true,
    draftBody: draft.body ?? "",
    knownCustomer: await knownCustomer(mailbox.id, customer?.address ?? null, draft.createdAt),
  });
}

/**
 * Right after a draft is written: if everything allows it, start the grace
 * window. Returns when it will send, or null if it waits for the owner.
 */
export async function considerAutopilot(
  draftId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const row = await loadForAutopilot(draftId);
  if (!row || row.draft.status !== "pending" || row.draft.autoSendAt) return null;
  if ((await blockers(row, now)).length) return null;
  if ((await sentByAutopilotToday(row.workspace.id, now)) >= DAILY_AUTOPILOT_CAP) return null;

  const at = new Date(now.getTime() + GRACE_MINUTES * 60_000);
  const [set] = await db()
    .update(drafts)
    .set({ autoSendAt: at })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")))
    .returning({ id: drafts.id });
  if (!set) return null;
  await db()
    .insert(activityLog)
    .values({
      workspaceId: row.workspace.id,
      actor: "squared_away",
      action: "autopilot_scheduled",
      threadId: row.thread.id,
      detail: { draftId, sendAt: at.toISOString() },
    });
  return at;
}

export type AutopilotSendResult =
  | { status: "sent" }
  | { status: "not_due" }
  | { status: "stood_down"; reasons: string[] }
  | { status: "gone" }
  | { status: "failed"; outcome: SendOutcome["status"] };

/**
 * When the grace window ends: check everything again — the owner may have
 * held it, edited it, switched autopilot off, the customer may have written
 * again, or the account may have changed — and only then send.
 */
export async function runAutopilotSend(
  draftId: string,
  opts: DraftDeps = {},
): Promise<AutopilotSendResult> {
  const now = opts.now?.() ?? new Date();
  const row = await loadForAutopilot(draftId);
  if (!row || row.draft.status !== "pending") return { status: "gone" };
  if (!row.draft.autoSendAt) return { status: "stood_down", reasons: ["Held or edited by you."] };
  if (row.draft.autoSendAt > now) return { status: "not_due" };

  const newer = await db()
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, row.thread.id),
        sql`${messages.sentAt} > ${row.draft.createdAt.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  const reasons = [
    ...(await blockers(row, now)),
    ...(newer.length ? ["There's newer mail in this conversation."] : []),
  ];
  if (reasons.length) {
    await db().update(drafts).set({ autoSendAt: null }).where(eq(drafts.id, draftId));
    await db()
      .insert(activityLog)
      .values({
        workspaceId: row.workspace.id,
        actor: "squared_away",
        action: "autopilot_stood_down",
        threadId: row.thread.id,
        detail: { draftId, reasonCount: reasons.length },
      });
    return { status: "stood_down", reasons };
  }

  const outcome = await sendDraft(row.workspace.id, draftId, { ...opts, by: "autopilot" });
  return outcome.status === "sent"
    ? { status: "sent" }
    : { status: "failed", outcome: outcome.status };
}

/** The owner's "Hold it": the draft stays, and waits for their tap like any other. */
export async function holdAutopilot(workspaceId: string, draftId: string): Promise<boolean> {
  const held = await db()
    .update(drafts)
    .set({ autoSendAt: null })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.autoSendAt),
        inArray(
          drafts.mailboxId,
          db()
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.workspaceId, workspaceId)),
        ),
      ),
    )
    .returning({ threadId: drafts.threadId });
  if (!held.length) return false;
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "autopilot_held",
    threadId: held[0]!.threadId,
    detail: { draftId },
  });
  return true;
}

/** Backstop for lost events: drafts whose window ended a while ago and are still waiting. */
export async function overdueAutopilotDrafts(now: Date = new Date()): Promise<string[]> {
  const rows = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.status, "pending"),
        isNotNull(drafts.autoSendAt),
        lte(drafts.autoSendAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    )
    .limit(50);
  return rows.map((r) => r.id);
}
