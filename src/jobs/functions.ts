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
import { classifyPending } from "@/server/classification";
import { createDraftForThread, reconcileDrafts, threadsToAutoDraft } from "@/server/drafts";
import { getMailboxWorkspace } from "@/server/mailboxes";
import { learnVoice, workspacesDueForVoiceRefresh } from "@/server/voice";
import {
  inngest,
  mailboxClassifyRequested,
  mailboxConnected,
  mailboxDraftRequested,
  mailboxSyncRequested,
  voiceLearnRequested,
} from "./client";

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
    await step.sendEvent("classify", mailboxClassifyRequested.create({ mailboxId }));
    const workspaceId = await step.run("workspace", () => getMailboxWorkspace(mailboxId));
    if (workspaceId)
      await step.sendEvent("learn-voice", voiceLearnRequested.create({ workspaceId }));
    return { status: "ok", ingested: total };
  },
);

/**
 * What runs after a sync: new mail gets sorted (which then drafts); no new
 * mail still reconciles drafts, since the owner may have edited, sent or
 * deleted them in Gmail.
 */
export function afterSync(mailboxId: string, ingested: number) {
  return ingested > 0
    ? mailboxClassifyRequested.create({ mailboxId })
    : mailboxDraftRequested.create({ mailboxId });
}

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
    const { mailboxId } = event.data;
    const result = await step.run("sync", () => incrementalSync(mailboxId));
    if (result.status === "reconnect_needed") {
      throw new NonRetriableError("Mailbox needs reconnecting.");
    }
    if (result.status === "ok") {
      await step.sendEvent("next", afterSync(mailboxId, result.ingested));
    }
    return result;
  },
);

/**
 * Sort waiting mail for one mailbox, ten messages per step so a failure only
 * retries its own batch. Stops early when the workspace hits its daily AI cap.
 */
export const classifyMailbox = inngest.createFunction(
  {
    id: "classify-mailbox",
    triggers: [mailboxClassifyRequested],
    concurrency: { key: "event.data.mailboxId", limit: 1 },
    debounce: { key: "event.data.mailboxId", period: "30s" },
    retries: 3,
  },
  async ({ event, step }) => {
    let total = 0;
    for (let round = 0; round < 50; round++) {
      const r = await step.run(`batch-${round}`, () =>
        classifyPending(event.data.mailboxId, { limit: 10 }),
      );
      total += r.classified;
      if (r.capped || r.remaining === 0) {
        await step.sendEvent(
          "draft",
          mailboxDraftRequested.create({ mailboxId: event.data.mailboxId }),
        );
        return { classified: total, capped: r.capped };
      }
    }
    await step.sendEvent(
      "draft",
      mailboxDraftRequested.create({ mailboxId: event.data.mailboxId }),
    );
    return { classified: total, capped: false };
  },
);

/**
 * Reconcile drafts with Gmail, then write replies for anything that's due —
 * one thread per step so a failure only retries that thread.
 */
export const draftMailbox = inngest.createFunction(
  {
    id: "draft-mailbox",
    triggers: [mailboxDraftRequested],
    concurrency: { key: "event.data.mailboxId", limit: 1 },
    debounce: { key: "event.data.mailboxId", period: "30s" },
    retries: 3,
  },
  async ({ event, step }) => {
    const { mailboxId } = event.data;
    await step.run("reconcile", () => reconcileDrafts(mailboxId));
    const due = await step.run("due", () => threadsToAutoDraft(mailboxId, 10));
    let created = 0;
    for (const threadId of due) {
      const r = await step.run(`draft-${threadId}`, () =>
        createDraftForThread(threadId, { trigger: "auto" }),
      );
      if (r.status === "created") created++;
      if (r.status === "reconnect_needed" || (r.status === "skipped" && r.reason === "capped"))
        break;
    }
    return { created };
  },
);

/** Read sent mail and describe how the owner writes. One at a time per workspace. */
export const learnVoiceFn = inngest.createFunction(
  {
    id: "learn-voice",
    triggers: [voiceLearnRequested],
    singleton: { key: "event.data.workspaceId", mode: "skip" },
    retries: 2,
  },
  async ({ event, step }) =>
    step.run("learn", () =>
      learnVoice(event.data.workspaceId, { force: event.data.force ?? false }),
    ),
);

/** Weekly: refresh learned voices (never ones the owner edited by hand). */
export const refreshVoices = inngest.createFunction(
  { id: "refresh-voices", triggers: [cron("23 8 * * 1")] },
  async ({ step }) => {
    const due = await step.run("due", () => workspacesDueForVoiceRefresh());
    if (due.length) {
      await step.sendEvent(
        "fan-out",
        due.map((workspaceId) => voiceLearnRequested.create({ workspaceId })),
      );
    }
    return { refreshed: due.length };
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
  classifyMailbox,
  draftMailbox,
  learnVoiceFn,
  refreshVoices,
  pollMailboxes,
  renewGmailWatches,
  purgeBodies,
];
