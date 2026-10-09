import { cron, NonRetriableError, RetryAfterError } from "inngest";
import { MailboxRateLimitError } from "@/mailbox/connector";
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
import { sendDigests } from "@/server/digest";
import { threadsToFollowUp } from "@/server/followups";
import { getMailboxWorkspace } from "@/server/mailboxes";
import { purgeRateLimits } from "@/server/rate-limit";
import { sendAccessLostAlerts } from "@/server/alerts";
import { captureQuoteAmounts } from "@/server/quotes";
import { sendLeadAlerts } from "@/server/sms-alerts";
import { learnVoice, workspacesDueForVoiceRefresh, workspacesNeedingVoice } from "@/server/voice";
import { expireEvaluations, startPendingEvaluations } from "@/server/workspace-lifecycle";
import { considerAutopilot, overdueAutopilotDrafts, runAutopilotSend } from "@/server/autopilot";
import {
  autopilotSendRequested,
  inngest,
  mailboxClassifyRequested,
  mailboxConnected,
  mailboxDraftRequested,
  mailboxSyncRequested,
  voiceLearnRequested,
} from "./client";

/** Text the owner about new leads in this mailbox's workspace (no-op unless they opted in). */
async function alertsForMailbox(mailboxId: string) {
  const workspaceId = await getMailboxWorkspace(mailboxId);
  return workspaceId ? sendLeadAlerts(new Date(), { workspaceId }) : { sent: 0 };
}

/**
 * Gmail said "slow down" more times than the client retries: pause this step
 * for a couple of minutes instead of failing, so the job picks up where it was.
 */
export async function politely<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailboxRateLimitError) {
      // Wait as long as Gmail asked (plus a minute), and never less than two minutes.
      const at = Math.max(Date.now() + 120_000, (err.retryAt?.getTime() ?? 0) + 60_000);
      throw new RetryAfterError("Gmail asked us to slow down.", new Date(at), { cause: err });
    }
    throw err;
  }
}

/**
 * 30-day backfill, one page per step so each step stays well under function
 * time limits and retries resume from the page that failed.
 */
export const backfillMailbox = inngest.createFunction(
  {
    id: "backfill-mailbox",
    triggers: [mailboxConnected],
    singleton: { key: "event.data.mailboxId", mode: "skip" },
    retries: 10,
  },
  async ({ event, step }) => {
    const { mailboxId } = event.data;
    const start = await step.run("begin", () => politely(() => beginBackfill(mailboxId)));
    if (start.status !== "ok") return start;

    let pageToken: string | undefined;
    let total = 0;
    for (let page = 0; ; page++) {
      const result = await step.run(`page-${page}`, () =>
        politely(() => backfillPage(mailboxId, pageToken)),
      );
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
    const result = await step.run("sync", () => politely(() => incrementalSync(mailboxId)));
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
        if (total > 0) await step.run("text-alerts", () => alertsForMailbox(event.data.mailboxId));
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
    await step.run("reconcile", () => politely(() => reconcileDrafts(mailboxId)));
    const due = await step.run("due", () => threadsToAutoDraft(mailboxId, 10));
    let created = 0;
    for (const threadId of due) {
      const r = await step.run(`draft-${threadId}`, () =>
        politely(() => createDraftForThread(threadId, { trigger: "auto" })),
      );
      if (r.status === "created") {
        created++;
        const draftId = r.draftId;
        const at = await step.run(`autopilot-${draftId}`, () => considerAutopilot(draftId));
        if (at) {
          await step.sendEvent(
            `autopilot-send-${draftId}`,
            autopilotSendRequested.create({ draftId, at: new Date(at).toISOString() }),
          );
        }
      }
      if (r.status === "reconnect_needed" || (r.status === "skipped" && r.reason === "capped"))
        break;
    }
    return { created };
  },
);

/**
 * Daily, 9am Eastern: nudge quiet quotes and invoices. Every nudge is a draft
 * in the queue — nothing is sent. One thread per step.
 */
export const followupScan = inngest.createFunction(
  { id: "followup-scan", triggers: [cron("TZ=America/New_York 11 9 * * *")], retries: 3 },
  async ({ step }) => {
    const boxes = await step.run("mailboxes", () => listSyncableMailboxes());
    let created = 0;
    for (const box of boxes) {
      if (!box.backfillCompletedAt) continue;
      const due = await step.run(`due-${box.id}`, () => threadsToFollowUp(box.id));
      for (const threadId of due) {
        const r = await step.run(`nudge-${threadId}`, () =>
          politely(() => createDraftForThread(threadId, { trigger: "followup" })),
        );
        if (r.status === "created") created++;
        if (r.status === "reconnect_needed" || (r.status === "skipped" && r.reason === "capped"))
          break;
      }
    }
    return { created };
  },
);

/** Hourly: each owner's morning summary goes out once a day at their hour. */
export const morningDigest = inngest.createFunction(
  { id: "morning-digest", triggers: [cron("3 * * * *")], retries: 3 },
  async ({ step }) => step.run("send", () => sendDigests()),
);

/**
 * Autopilot's grace window: wait until the send time (the owner can hold or
 * edit it meanwhile), then check everything again and send only if it all
 * still holds. Idempotent: a draft that's already gone or held is left alone.
 */
export const autopilotSend = inngest.createFunction(
  {
    id: "autopilot-send",
    triggers: [autopilotSendRequested],
    singleton: { key: "event.data.draftId", mode: "skip" },
    retries: 3,
  },
  async ({ event, step }) => {
    await step.sleepUntil("grace-window", new Date(event.data.at));
    return step.run("send", () => politely(() => runAutopilotSend(event.data.draftId)));
  },
);

/** Read sent mail and describe how the owner writes. One at a time per workspace. */
export const learnVoiceFn = inngest.createFunction(
  {
    id: "learn-voice",
    triggers: [voiceLearnRequested],
    singleton: { key: "event.data.workspaceId", mode: "skip" },
    retries: 6,
  },
  async ({ event, step }) =>
    step.run("learn", () =>
      politely(() => learnVoice(event.data.workspaceId, { force: event.data.force ?? false })),
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

/**
 * Every 15 minutes: start the clock for anyone who connected Gmail but wasn't
 * moved (backstop), record evaluations that have run out, and restart stuck
 * voice learning. Gates don't wait
 * for this — they read the clock directly.
 */
export const workspaceLifecycle = inngest.createFunction(
  { id: "workspace-lifecycle", triggers: [cron("*/15 * * * *")] },
  async ({ step }) => {
    const started = await step.run("start", () => startPendingEvaluations());
    const expired = await step.run("expire", () => expireEvaluations());
    // Autopilot drafts whose send event was lost: send (or stand down) now.
    const overdue = await step.run("autopilot-overdue", () => overdueAutopilotDrafts());
    if (overdue.length) {
      await step.sendEvent(
        "autopilot-overdue",
        overdue.map((draftId) =>
          autopilotSendRequested.create({ draftId, at: new Date().toISOString() }),
        ),
      );
    }
    // Also restart any voice learning that never ran or died part-way.
    const voice = await step.run("voice", () => workspacesNeedingVoice());
    if (voice.length) {
      await step.sendEvent(
        "learn-voice",
        voice.map((workspaceId) => voiceLearnRequested.create({ workspaceId })),
      );
    }
    // Tell owners when Gmail access is lost (and remind once), so leads aren't silently missed.
    const alerts = await step.run("access-lost-alerts", () => sendAccessLostAlerts());
    // Backstop for text alerts held overnight or throttled.
    await step.run("text-alerts", () => sendLeadAlerts());
    return { started, expired, voiceRestarted: voice.length, accessAlerts: alerts.sent };
  },
);

/** Daily: renew Gmail push watches before they silently expire. */
export const renewGmailWatches = inngest.createFunction(
  { id: "renew-gmail-watches", triggers: [cron("17 6 * * *")] },
  async ({ step }) => ({ renewed: await step.run("renew", () => renewWatches()) }),
);

/** Daily: purge email text past the retention window (and stale rate-limit windows). */
export const purgeBodies = inngest.createFunction(
  { id: "purge-expired-bodies", triggers: [cron("41 7 * * *")] },
  async ({ step }) => {
    // Keep each quote's amount before the owner's reply text is purged.
    await step.run("capture-quote-amounts", () => captureQuoteAmounts());
    const purged = await step.run("purge", () => purgeExpiredBodies());
    await step.run("purge-rate-limits", () => purgeRateLimits());
    return { purged };
  },
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
  workspaceLifecycle,
  followupScan,
  morningDigest,
  autopilotSend,
];
