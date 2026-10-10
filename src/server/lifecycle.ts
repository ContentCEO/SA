import { pricing } from "@/config/pricing";
import type { Workspace } from "@/db/schema";

/**
 * The commercial flow, as rules. Pure functions only — the database side is in
 * `workspace-lifecycle.ts`. Changing anything here changes what owners can do;
 * the flow itself is Davi's call (see CLAUDE.md).
 *
 *   invited → evaluating (3 days, no sending) → evaluation_expired (read-only)
 *   → setup_paid (sending on, setup call pending) → active
 *   → past_due / canceled / paused
 */
type Status = Workspace["status"];
type Clocked = Pick<Workspace, "status" | "evaluationEndsAt">;
type Payable = Clocked & Pick<Workspace, "setupPaidVia">;

export const EVALUATION_MS = pricing.evaluationDays * 86_400_000;

/**
 * The status that counts right now. An evaluation whose clock has run out is
 * expired even before the job that records it has run, so no gate depends on
 * a cron being on time.
 */
export function effectiveStatus(w: Clocked, now: Date = new Date()): Status {
  if (w.status === "evaluating" && w.evaluationEndsAt && w.evaluationEndsAt <= now) {
    return "evaluation_expired";
  }
  return w.status;
}

/**
 * Sending is the one irreversible thing we do, so it's gated here and nowhere
 * else. Two things must both be true: the status allows it, AND setup was
 * really paid — confirmed by Stripe's signed webhook ("stripe"), or it's Davi's
 * own admin account ("house"). No button, status change or admin move alone
 * can turn sending on (Davi, 2026-10-10).
 */
export const SENDING_ALLOWED: readonly Status[] = ["setup_paid", "active"];
export const PAID_VIA: readonly NonNullable<Workspace["setupPaidVia"]>[] = ["stripe", "house"];

export function setupReallyPaid(w: Pick<Workspace, "setupPaidVia">): boolean {
  return !!w.setupPaidVia && PAID_VIA.includes(w.setupPaidVia);
}

export function canSend(w: Payable, now: Date = new Date()): boolean {
  return SENDING_ALLOWED.includes(effectiveStatus(w, now)) && setupReallyPaid(w);
}

/**
 * Statuses where we keep working the inbox: syncing, sorting, drafting,
 * learning the voice. Everything else is read-only — the owner can look at
 * what's there, but nothing new is read, drafted, or changed in Gmail, and no
 * AI is spent. Past due pauses jobs but never deletes data.
 */
export const JOBS_ALLOWED: readonly Status[] = ["invited", "evaluating", "setup_paid", "active"];

export function jobsAllowed(w: Clocked, now: Date = new Date()): boolean {
  return JOBS_ALLOWED.includes(effectiveStatus(w, now));
}

/** Read-only: owner actions that write to Gmail or spend AI are refused. */
export function isReadOnly(w: Clocked, now: Date = new Date()): boolean {
  return !jobsAllowed(w, now);
}

export class SendingBlockedError extends Error {
  constructor(public readonly status: Status) {
    super(`Sending is blocked for workspaces in status "${status}".`);
    this.name = "SendingBlockedError";
  }
}

export class ReadOnlyError extends Error {
  constructor(public readonly status: Status) {
    super(`Workspace is read-only in status "${status}".`);
    this.name = "ReadOnlyError";
  }
}

export function sendingBlockedReason(w: Payable, now: Date = new Date()): string {
  const status = effectiveStatus(w, now);
  if (SENDING_ALLOWED.includes(status) && !setupReallyPaid(w)) {
    return "Sending turns on once your setup payment goes through. Choose a plan in Settings → Plan & billing.";
  }
  switch (status) {
    case "evaluating":
      return "Read the drafts and see if they sound like you.";
    case "evaluation_expired":
      return "Your three days are up. Nothing else changes until then.";
    case "past_due":
      return "Sending is paused until the payment issue is sorted.";
    case "canceled":
      return "Your plan is canceled, so sending is off.";
    case "paused":
      return "Your account is paused, so sending is off.";
    default:
      return "Sending isn't switched on for your account yet.";
  }
}

/** Short label for the spot where the Send button would be. */
export function sendingOffLabel(w: Payable, now: Date = new Date()): string {
  const status = effectiveStatus(w, now);
  if (SENDING_ALLOWED.includes(status) && !setupReallyPaid(w))
    return "Waiting on your setup payment";
  switch (status) {
    case "evaluating":
      return "Sending is off during your three days";
    case "evaluation_expired":
      return "Sending turns on after setup";
    case "past_due":
      return "Sending paused — payment issue";
    default:
      return "Sending isn't on yet";
  }
}

/**
 * Admin moves Davi can make by hand. Each lists the statuses it may start
 * from; anything else is refused. There is deliberately no "mark setup paid":
 * only a real Stripe payment does that. `house_account` is only accepted for
 * the workspace Davi himself owns (checked server-side in applyAdminMove).
 */
export const ADMIN_MOVES = {
  extend_evaluation: ["invited", "evaluating", "evaluation_expired"],
  house_account: ["invited", "evaluating", "evaluation_expired", "setup_paid", "active"],
  mark_setup_call_done: ["setup_paid"],
  pause: ["invited", "evaluating", "evaluation_expired", "setup_paid", "active", "past_due"],
  resume: ["paused"],
} as const satisfies Record<string, readonly Status[]>;

export type AdminMove = keyof typeof ADMIN_MOVES;

export function isAdminMove(v: unknown): v is AdminMove {
  return typeof v === "string" && Object.hasOwn(ADMIN_MOVES, v);
}

export function canMakeMove(move: AdminMove, w: Clocked, now: Date = new Date()): boolean {
  return (ADMIN_MOVES[move] as readonly Status[]).includes(effectiveStatus(w, now));
}

/** Where a paused workspace goes back to: as far as it had got before. */
export function resumeTarget(
  w: Pick<Workspace, "setupPaidAt" | "setupCallCompletedAt" | "evaluationEndsAt">,
  now: Date = new Date(),
): Status {
  if (w.setupCallCompletedAt) return "active";
  if (w.setupPaidAt) return "setup_paid";
  if (w.evaluationEndsAt) return w.evaluationEndsAt > now ? "evaluating" : "evaluation_expired";
  return "invited";
}

export type Clock = { day: number; of: number; msLeft: number };

/** "Day 2 of 3", for the evaluation banner. Null outside an evaluation. */
export function evaluationClock(
  w: Pick<Workspace, "status" | "evaluationStartedAt" | "evaluationEndsAt">,
  now: Date = new Date(),
): Clock | null {
  if (effectiveStatus(w, now) !== "evaluating" || !w.evaluationEndsAt) return null;
  const msLeft = w.evaluationEndsAt.getTime() - now.getTime();
  const started = w.evaluationStartedAt ?? new Date(w.evaluationEndsAt.getTime() - EVALUATION_MS);
  const of = Math.max(
    1,
    Math.round((w.evaluationEndsAt.getTime() - started.getTime()) / 86_400_000),
  );
  const day = Math.min(of, Math.floor((now.getTime() - started.getTime()) / 86_400_000) + 1);
  return { day: Math.max(1, day), of, msLeft };
}

/** "2 days, 5 hours" / "3 hours" / "under an hour". */
export function timeLeft(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "under an hour";
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  const d = days ? `${days} day${days === 1 ? "" : "s"}` : "";
  const hh = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  return [d, hh].filter(Boolean).join(", ");
}
