import type { Workspace } from "@/db/schema";

/**
 * Sending is the one irreversible thing we do, so it's gated here and nowhere
 * else. Only a workspace that has paid for setup (or is active) can send.
 * Evaluation, expired, past-due, canceled, paused and invited all read and
 * draft, but cannot send. Milestone 6 adds the transitions between states.
 */
export const SENDING_ALLOWED: readonly Workspace["status"][] = ["setup_paid", "active"];

export function canSend(workspace: Pick<Workspace, "status">): boolean {
  return SENDING_ALLOWED.includes(workspace.status);
}

export function sendingBlockedReason(workspace: Pick<Workspace, "status">): string {
  switch (workspace.status) {
    case "evaluating":
      return "Sending is off during your three days. Read the drafts and see if they sound like you.";
    case "evaluation_expired":
      return "Your three days are up. Sending turns on once setup is paid.";
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

export class SendingBlockedError extends Error {
  constructor(public readonly status: Workspace["status"]) {
    super(`Sending is blocked for workspaces in status "${status}".`);
    this.name = "SendingBlockedError";
  }
}

/** Short label for the spot where the Send button would be. */
export function sendingOffLabel(workspace: Pick<Workspace, "status">): string {
  switch (workspace.status) {
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
