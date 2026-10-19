import * as Sentry from "@sentry/nextjs";
import { eventType, Inngest, Middleware, staticSchema } from "inngest";
import { countJobRun } from "@/server/job-runs";
import { scrubText } from "@/lib/sentry";

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

/**
 * Check 26 P5: Inngest keeps a failed step's or run's error message (and stack) in its run
 * history. Before it's sent, scrub them the way Sentry's events are (`scrubText`: a failed
 * query's "params: …" dropped, email addresses masked). The error object itself is kept, so
 * NonRetriableError / RetryAfterError still work.
 */
export function scrubJobError(err: unknown): unknown {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e instanceof Error && !seen.has(e)) {
    seen.add(e);
    try {
      e.message = scrubText(e.message) ?? "";
      if (e.stack) e.stack = scrubText(e.stack);
      // DrizzleQueryError keeps its bound values on the error too.
      if ("params" in e) delete (e as { params?: unknown }).params;
    } catch {
      // A read-only message (a getter, a frozen error): leave it; Sentry's scrub still runs.
    }
    e = e.cause;
  }
  return err;
}

class ScrubErrors extends Middleware.BaseMiddleware {
  readonly id = "scrub-errors";
  async wrapFunctionHandler({ next }: Middleware.WrapFunctionHandlerArgs) {
    try {
      return await next();
    } catch (err) {
      throw scrubJobError(err);
    }
  }
  async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
    try {
      return await next();
    } catch (err) {
      throw scrubJobError(err);
    }
  }
}

/**
 * Check 25 P4: count runs and executed steps per job and day (counts only), so /admin can
 * show the month's background work against Inngest's plan. Memoized steps aren't counted.
 */
class CountJobRuns extends Middleware.BaseMiddleware {
  readonly id = "count-job-runs";
  async onRunStart({ fn }: Middleware.OnRunStartArgs) {
    await countJobRun(fn.id(), "run");
  }
  async onStepComplete({ fn }: Middleware.OnStepCompleteArgs) {
    await countJobRun(fn.id(), "step");
  }
  async onStepError({ fn }: Middleware.OnStepErrorArgs) {
    await countJobRun(fn.id(), "step");
  }
}

export const inngest = new Inngest({
  id: "squared-away",
  middleware: [ScrubErrors, ReportFinalFailures, CountJobRuns],
});

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

/** Check 24 P8: the voice's sample replies went stale (an edit or an accepted idea); rewrite them. */
export const voiceExamplesRequested = eventType("voice/examples.requested", {
  schema: staticSchema<{ workspaceId: string }>(),
});

/** Round 2 (FW D2): the owner tapped "Draft them" on found money. Ids worked out by the server. */
export const foundMoneyDraftsRequested = eventType("first-week/found-money.requested", {
  schema: staticSchema<{ workspaceId: string; replies: string[]; nudges: string[] }>(),
});

/**
 * Check 25 P4: the Reply-To backfill isn't finished; run it again (sent with a `ts` 15 minutes
 * ahead). Once finished it only wakes on its daily cron.
 */
export const replyToBackfillContinue = eventType("reply-to-backfill/continue", {
  schema: staticSchema<{ run: number }>(),
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
