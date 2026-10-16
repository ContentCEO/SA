import * as Sentry from "@sentry/nextjs";
import { eventType, Inngest, Middleware, staticSchema } from "inngest";

/**
 * A job that has used up its retries goes to Sentry (scrubbed; a no-op without
 * a DSN). Earlier attempts — rate-limit pauses included — are expected noise.
 */
class ReportFinalFailures extends Middleware.BaseMiddleware {
  readonly id = "report-final-failures";
  async onRunError({ error, fn, isFinalAttempt }: Middleware.OnRunErrorArgs) {
    if (!isFinalAttempt) return;
    Sentry.captureException(error, { tags: { job: fn.id() } });
    await Sentry.flush(2000); // serverless: send before the function freezes
  }
}

export const inngest = new Inngest({ id: "squared-away", middleware: [ReportFinalFailures] });

/** A mailbox was connected or reconnected: run (or re-run) the 30-day backfill. */
export const mailboxConnected = eventType("mailbox/connected", {
  schema: staticSchema<{ mailboxId: string }>(),
});

/** Something may have changed in a mailbox (poll tick or Gmail push). */
export const mailboxSyncRequested = eventType("mailbox/sync.requested", {
  schema: staticSchema<{ mailboxId: string }>(),
});

/** New inbound mail landed: sort it. */
export const mailboxClassifyRequested = eventType("mailbox/classify.requested", {
  schema: staticSchema<{ mailboxId: string }>(),
});

/** Reconcile drafts with Gmail, then write any replies that are due. */
export const mailboxDraftRequested = eventType("mailbox/draft.requested", {
  schema: staticSchema<{ mailboxId: string }>(),
});

/** Autopilot: send this draft at `at` if every check still passes then. */
export const autopilotSendRequested = eventType("autopilot/send.requested", {
  schema: staticSchema<{ draftId: string; at: string }>(),
});

/** Plan #7: the owner tapped Send reply; send at `at` unless they undo it. */
export const draftSendQueued = eventType("draft/send.queued", {
  schema: staticSchema<{ draftId: string; at: string }>(),
});

/** Learn (or re-learn) how the owner writes. `force` overrides their manual edits. */
export const voiceLearnRequested = eventType("voice/learn.requested", {
  schema: staticSchema<{ workspaceId: string; force?: boolean }>(),
});

/**
 * Fire-and-forget enqueue. If the queue is unreachable we log (content-free)
 * and move on — the 5-minute poll picks up anything missed.
 */
export async function enqueue(event: Parameters<typeof inngest.send>[0] & { name: string }) {
  try {
    await inngest.send(event);
  } catch (err) {
    console.error("enqueue_failed", { event: event.name, error: (err as Error).name });
  }
}
