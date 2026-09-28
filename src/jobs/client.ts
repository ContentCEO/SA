import { eventType, Inngest, staticSchema } from "inngest";

export const inngest = new Inngest({ id: "squared-away" });

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
