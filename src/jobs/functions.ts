import { cron, NonRetriableError } from "inngest";
import {
  backfillPage,
  beginBackfill,
  finishBackfill,
  incrementalSync,
  listSyncableMailboxes,
  purgeExpiredBodies,
  renewWatches,
} from "@/server/sync";
import { inngest, mailboxConnected, mailboxSyncRequested } from "./client";

/**
 * 30-day backfill, one page per step so each step stays well under function
 * time limits and retries resume from the page that failed.
 */
export const backfillMailbox = inngest.createFunction(
  {
    id: "backfill-mailbox",
    triggers: [mailboxConnected],
    singleton: { key: "event.data.mailboxId", mode: "skip" },
    retries: 5,
  },
  async ({ event, step }) => {
    const { mailboxId } = event.data;
    const start = await step.run("begin", () => beginBackfill(mailboxId));
    if (start.status !== "ok") return start;

    let pageToken: string | undefined;
    let total = 0;
    for (let page = 0; ; page++) {
      const result = await step.run(`page-${page}`, () => backfillPage(mailboxId, pageToken));
      if (result.status !== "ok") return result;
      total += result.ingested;
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    await step.run("finish", () => finishBackfill(mailboxId));
    return { status: "ok", ingested: total };
  },
);

/** Incremental sync for one mailbox. One at a time per mailbox; bursts collapse. */
export const syncMailbox = inngest.createFunction(
  {
    id: "sync-mailbox",
    triggers: [mailboxSyncRequested],
    concurrency: { key: "event.data.mailboxId", limit: 1 },
    debounce: { key: "event.data.mailboxId", period: "20s" },
    retries: 4,
  },
  async ({ event, step }) => {
    const result = await step.run("sync", () => incrementalSync(event.data.mailboxId));
    if (result.status === "reconnect_needed")
      throw new NonRetriableError("Mailbox needs reconnecting.");
    return result;
  },
);

/** Every 5 minutes: poll every active mailbox, and start any backfill that never ran. */
export const pollMailboxes = inngest.createFunction(
  { id: "poll-mailboxes", triggers: [cron("*/5 * * * *")] },
  async ({ step }) => {
    const boxes = await step.run("list", () => listSyncableMailboxes());
    if (boxes.length === 0) return { polled: 0 };
    await step.sendEvent(
      "fan-out",
      boxes.map((b) =>
        b.backfillCompletedAt
          ? mailboxSyncRequested.create({ mailboxId: b.id })
          : mailboxConnected.create({ mailboxId: b.id }),
      ),
    );
    return { polled: boxes.length };
  },
);

/** Daily: renew Gmail push watches before they silently expire. */
export const renewGmailWatches = inngest.createFunction(
  { id: "renew-gmail-watches", triggers: [cron("17 6 * * *")] },
  async ({ step }) => ({ renewed: await step.run("renew", () => renewWatches()) }),
);

/** Daily: purge email text past the retention window. */
export const purgeBodies = inngest.createFunction(
  { id: "purge-expired-bodies", triggers: [cron("41 7 * * *")] },
  async ({ step }) => ({ purged: await step.run("purge", () => purgeExpiredBodies()) }),
);

export const functions = [
  backfillMailbox,
  syncMailbox,
  pollMailboxes,
  renewGmailWatches,
  purgeBodies,
];
