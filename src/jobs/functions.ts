import * as Sentry from "@sentry/nextjs";
import { cron, NonRetriableError, RetryAfterError } from "inngest";
import { MailboxRateLimitError } from "@/mailbox/connector";
import { ModelUnavailableError } from "@/ai/client";
import {
  backfillPage,
  beginBackfill,
  finishBackfill,
  incrementalSync,
  listSyncableMailboxes,
  MAX_BACKFILL_PAGES_PER_RUN,
  MAX_RESYNC_PAGES_PER_RUN,
  resyncPage,
  purgeExpiredBodies,
  renewWatches,
} from "@/server/sync";
import { classifyPending } from "@/server/classification";
import { unsortedSweepMailboxes } from "@/server/assistant-status";
import { purgeCostAlertMarkers, sendCostAlerts } from "@/server/admin-costs";
import { captureEditSignals, proposeVoiceUpdates } from "@/server/edit-learning";
import {
  createDraftForThread,
  deliverQueuedSend,
  overdueQueuedSends,
  reconcileDrafts,
  threadsToAutoDraft,
} from "@/server/drafts";
import { sendDigests } from "@/server/digest";
import { sendMonthlySummaries } from "@/server/monthly-summary";
import { threadsToFollowUp } from "@/server/followups";
import { getMailboxWorkspace } from "@/server/mailboxes";
import { purgeRateLimits } from "@/server/rate-limit";
import { purgeGmailUnits } from "@/server/gmail-units";
import { purgeJobRuns } from "@/server/job-runs";
import { purgeEmailSentRecords } from "@/lib/email";
import { purgeStaleDraftClaims } from "@/server/draft-claims";
import { sendAccessLostAlerts } from "@/server/alerts";
import { purgeAdminNoticeMarkers } from "@/server/admin-notify";
import { recordLifecycleRun } from "@/server/health-deep";
import { captureQuoteAmounts, guessNoAnswers } from "@/server/quotes";
import { sendLeadAlerts } from "@/server/sms-alerts";
import { sendEmergencyAlerts } from "@/server/emergency-alerts";
import { sendPushAlerts } from "@/server/push-alerts";
import { sendLeadAtRiskPushes } from "@/server/leads-at-risk";
import { purgeExpiredNotes } from "@/server/seasonal-notes";
import {
  learnVoice,
  purgeVoiceAlertMarkers,
  restartVoiceLearns,
  workspacesDueForVoiceRefresh,
} from "@/server/voice";
import {
  enforcePlanAutopilot,
  expireEvaluations,
  startPendingEvaluations,
} from "@/server/workspace-lifecycle";
import { fitAllMailboxesToPlans } from "@/server/mailbox-plan";
import { sendTrialEmails } from "@/server/trial-emails";
import { runDraftMessagesCleanup } from "@/server/draft-message-cleanup";
import { runVoiceIdeaCleanup } from "@/server/voice-idea-cleanup";
import {
  finishReplyToBackfill,
  replyToBackfillMailboxes,
  runReplyToBackfillMailbox,
  type MailboxBackfillResult,
} from "@/server/reply-to-backfill";
import { runM7Backfill } from "@/server/m7-backfill";
import { draftFoundMoneyThread, sendFirstDraftsReady } from "@/server/first-week";
import { runReferralRewards } from "@/server/referrals";
import { considerAutopilot, overdueAutopilotDrafts, runAutopilotSend } from "@/server/autopilot";
import {
  autopilotSendRequested,
  draftSendQueued,
  foundMoneyDraftsRequested,
  inngest,
  mailboxClassifyRequested,
  mailboxConnected,
  mailboxDraftRequested,
  mailboxSyncRequested,
  replyToBackfillContinue,
  voiceLearnRequested,
} from "./client";

/**
 * Text / notify the owner about new leads in this mailbox's workspace (no-op unless opted in).
 * An emergency goes first, on its own (replies package, B5 part 2): it takes the shared slot,
 * and the ordinary alert then leaves it out.
 */
async function alertsForMailbox(mailboxId: string) {
  const workspaceId = await getMailboxWorkspace(mailboxId);
  if (!workspaceId) return { sent: 0 };
  const emergency = await sendEmergencyAlerts(new Date(), { workspaceId });
  const push = await sendPushAlerts(new Date(), { workspaceId });
  const sms = await sendLeadAlerts(new Date(), { workspaceId });
  return { sent: sms.sent, pushed: push.sent, emergencies: emergency.sent };
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
 * Check 48 P3: a model Anthropic says is missing won't come back on a retry a few seconds later.
 * Stop retrying this run (the call was refunded and Davi was told); the mail stays unsorted and
 * the 15-minute sweep picks it up once the model answers again.
 */
export async function stopIfModelMissing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      throw new NonRetriableError("The AI model isn't available.", { cause: err });
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

    // Check 25 P5: at most MAX_BACKFILL_PAGES_PER_RUN pages per run (Inngest stops a run at
    // 1,000 steps). A stopped read resumes from its saved token: the 5-minute poll starts the
    // next stretch, and the singleton keeps two from overlapping.
    let total = 0;
    let done = false;
    for (let page = 0; page < MAX_BACKFILL_PAGES_PER_RUN; page++) {
      const result = await step.run(`page-${page}`, () => politely(() => backfillPage(mailboxId)));
      if (result.status !== "ok") return result;
      total += result.ingested;
      if (result.done) {
        done = true;
        break;
      }
    }
    if (!done) return { status: "continuing" as const, ingested: total };
    await step.run("finish", () => finishBackfill(mailboxId));
    await step.sendEvent("classify", mailboxClassifyRequested.create({ mailboxId }));
    const workspaceId = await step.run("workspace", () => getMailboxWorkspace(mailboxId));
    if (workspaceId)
      await step.sendEvent("learn-voice", voiceLearnRequested.create({ workspaceId }));
    return { status: "ok", ingested: total };
  },
);

/**
 * What runs after a sync: new mail gets sorted (which then drafts). With no new mail, drafts
 * are reconciled (the owner may have edited, sent or deleted them in Gmail) only when there is
 * something to reconcile — a pending draft or a queued send (Check 25 P4: a quiet inbox no
 * longer runs the draft job every 5 minutes). Null = nothing to do.
 */
export function afterSync(mailboxId: string, ingested: number, hasPending = false) {
  if (ingested > 0) return mailboxClassifyRequested.create({ mailboxId });
  return hasPending ? mailboxDraftRequested.create({ mailboxId }) : null;
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
    if (result.status === "resync_needed") {
      // Check 25 P3: Gmail's history expired; re-read the gap one page per step. A very big gap
      // stops after MAX_RESYNC_PAGES_PER_RUN and the next sync event carries on from the token.
      let ingested = 0;
      for (let page = 0; page < MAX_RESYNC_PAGES_PER_RUN; page++) {
        const r = await step.run(`resync-page-${page}`, () =>
          politely(() => resyncPage(mailboxId)),
        );
        if (r.status === "reconnect_needed")
          throw new NonRetriableError("Mailbox needs reconnecting.");
        if (r.status !== "ok") return r;
        ingested += r.ingested;
        if (r.done) {
          const next = afterSync(mailboxId, ingested, true);
          if (next) await step.sendEvent("next", next);
          return { status: "ok" as const, ingested };
        }
      }
      const next = afterSync(mailboxId, ingested);
      if (next) await step.sendEvent("next", next);
      return { status: "resync_continuing" as const, ingested };
    }
    if (result.status === "ok") {
      const next = afterSync(mailboxId, result.ingested, result.hasPending ?? false);
      if (next) await step.sendEvent("next", next);
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
        stopIfModelMissing(() => classifyPending(event.data.mailboxId, { limit: 10 })),
      );
      // Check 39 P1: emails stored by the checks in code after the AI limit count too (they are
      // in `classified`), so a gas smell on a capped day still alerts the owner.
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
        stopIfModelMissing(() =>
          politely(() => createDraftForThread(threadId, { trigger: "auto" })),
        ),
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
    // Round 2 (FW D4): the first drafts after the first read → tell the owner, once ever.
    if (created) {
      const workspaceId = await step.run("workspace", () => getMailboxWorkspace(mailboxId));
      if (workspaceId) {
        await step.run("first-drafts-ready", () =>
          sendFirstDraftsReady(new Date(), { workspaceId }),
        );
      }
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
    // Quotes that went quiet after the nudges get our "no answer" guess first (plan #30);
    // a decided quote is never nudged again.
    await step.run("guess-no-answer", () => guessNoAnswers());
    const boxes = await step.run("mailboxes", () => listSyncableMailboxes());
    let created = 0;
    for (const box of boxes) {
      if (!box.backfillCompletedAt) continue;
      const due = await step.run(`due-${box.id}`, () => threadsToFollowUp(box.id));
      for (const threadId of due) {
        const r = await step.run(`nudge-${threadId}`, () =>
          stopIfModelMissing(() =>
            politely(() => createDraftForThread(threadId, { trigger: "followup" })),
          ),
        );
        if (r.status === "created") created++;
        if (r.status === "reconnect_needed" || (r.status === "skipped" && r.reason === "capped"))
          break;
      }
    }
    return { created };
  },
);

/**
 * Hourly: each owner's morning summary goes out once a day at their hour, and on their 1st
 * the summary of the month just ended (plan #35).
 */
export const morningDigest = inngest.createFunction(
  { id: "morning-digest", triggers: [cron("3 * * * *")], retries: 3 },
  async ({ step }) => {
    const digests = await step.run("send", () => sendDigests());
    // Plan #35: on the owner's 1st, the month just ended (same switch and hour). Both senders
    // catch each owner's failure, so one owner's refused email can't stop this step.
    const monthly = await step.run("monthly", () => sendMonthlySummaries());
    // ...but a failure must still reach the error alerts: fail the run AFTER both steps.
    // Retries replay the finished steps (nothing is re-sent); the last attempt goes through
    // ReportFinalFailures. The next hourly run tries the failed owners again.
    reportSummaryFailures(digests, monthly);
    return { digests, monthly };
  },
);

/** Thrown when some owners' summaries failed. Counts only — no ids, addresses or messages. */
export class SummaryFailuresError extends Error {
  override readonly name = "SummaryFailuresError";
}

/** Fails the morning-digest run when any owner's morning or monthly summary failed. */
export function reportSummaryFailures(
  digests: { failed: number },
  monthly: { failed: number },
): void {
  if (digests.failed > 0 || monthly.failed > 0) {
    throw new SummaryFailuresError(
      `Summaries failed: ${digests.failed} morning, ${monthly.failed} monthly.`,
    );
  }
}

/** Thrown when some alert emails were refused. Counts only — no ids, addresses or messages. */
export class AlertFailuresError extends Error {
  override readonly name = "AlertFailuresError";
}

/** Check 18 P1: fails a job run at its very end when any alert email failed. */
export function reportAlertFailures(kind: "access" | "cost", result: { failed: number }): void {
  if (result.failed > 0) {
    throw new AlertFailuresError(`Alert emails failed: ${result.failed} ${kind}.`);
  }
}

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

/**
 * Plan #7: wait out the undo window, then send — deliverQueuedSend claims the
 * draft (so a duplicate event can't send twice) and re-runs the whole gate.
 */
export const sendAfterUndo = inngest.createFunction(
  { id: "send-after-undo", triggers: [draftSendQueued], retries: 4 },
  async ({ event, step }) => {
    await step.sleepUntil("undo-window", new Date(event.data.at));
    return step.run("send", () => politely(() => deliverQueuedSend(event.data.draftId)));
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
      stopIfModelMissing(() =>
        politely(() => learnVoice(event.data.workspaceId, { force: event.data.force ?? false })),
      ),
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

/** Weekly (plan #21): ideas from the owner's edits. Nothing changes until they say yes. */
export const voiceIdeas = inngest.createFunction(
  { id: "voice-ideas", triggers: [cron("37 8 * * 1")] },
  async ({ step }) => {
    await step.run("capture", () => captureEditSignals());
    return {
      created: await step.run("propose", () => stopIfModelMissing(() => proposeVoiceUpdates())),
    };
  },
);

/** Every 5 minutes: poll every active mailbox, and start any backfill that never ran. */
export const pollMailboxes = inngest.createFunction(
  { id: "poll-mailboxes", triggers: [cron("*/5 * * * *")] },
  async ({ step }) => {
    const boxes = await step.run("list", () =>
      listSyncableMailboxes(new Date(), { forPoll: true }),
    );
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

/** Check 25 P4: one or more of the lifecycle job's checks threw (each was reported). */
export class LifecycleChecksFailedError extends Error {
  constructor(failed: string[]) {
    super(`Lifecycle checks failed: ${failed.join(", ")}.`);
    this.name = "LifecycleChecksFailedError";
  }
}

/**
 * Check 25 P4: run several checks inside one step, each on its own: a failure is reported
 * (content-free: the error and the check's name) and the rest still run. The step itself never
 * throws, so a retry doesn't redo the checks that worked; the run fails at the end instead.
 */
export async function runChecks<T extends Record<string, () => Promise<unknown>>>(
  checks: T,
): Promise<{ results: { [K in keyof T]?: Awaited<ReturnType<T[K]>> }; failed: string[] }> {
  const results: { [K in keyof T]?: Awaited<ReturnType<T[K]>> } = {};
  const failed: string[] = [];
  for (const [name, fn] of Object.entries(checks) as [keyof T & string, () => Promise<unknown>][]) {
    try {
      results[name] = (await fn()) as Awaited<ReturnType<T[typeof name]>>;
    } catch (err) {
      failed.push(name);
      Sentry.captureException(err, { tags: { job: "workspace-lifecycle", check: name } });
    }
  }
  return { results, failed };
}

/**
 * Every 15 minutes: start the clock for anyone who connected Gmail but wasn't
 * moved (backstop), record evaluations that have run out, and restart stuck
 * voice learning. Gates don't wait for this — they read the clock directly.
 *
 * Check 25 P4: four steps instead of fourteen (Inngest bills per step). Every check still runs
 * every time, each on its own (`runChecks`); the run fails at the end if any check failed, so
 * ReportFinalFailures still hears about it.
 */
export const workspaceLifecycle = inngest.createFunction(
  { id: "workspace-lifecycle", triggers: [cron("*/15 * * * *")] },
  async ({ step }) => {
    const clock = await step.run("clock", () =>
      runChecks({
        start: () => startPendingEvaluations(),
        expire: () => expireEvaluations(),
        // Plan #47: no category stays on autopilot under a plan without it (any path, any delay).
        "enforce-plan-autopilot": () => enforcePlanAutopilot(),
        // 2026-10-16: Gmail addresses over the plan's limit are paused (and back on with
        // room). Plan changes do this themselves; this catches one that didn't finish.
        "fit-mailboxes-to-plans": () => fitAllMailboxesToPlans(),
      }),
    );
    const backstops = await step.run("backstops", () =>
      runChecks({
        // Autopilot drafts whose send event was lost: send (or stand down) now.
        "autopilot-overdue": () => overdueAutopilotDrafts(),
        // Sends whose undo window ended but whose event was lost (plan #7).
        "sends-overdue": () => overdueQueuedSends(),
        // Review D4: mail that waited over 10 minutes unsorted (an AI outage, a lost event) is
        // sorted again now, not whenever that inbox next gets mail.
        "unsorted-sweep": () => unsortedSweepMailboxes(),
        // Voice learning that never ran or died part-way (Check 29 P2: at most 2 restarts),
        // and a failed first learn retried within the hour (Check 24 P12).
        voice: () => restartVoiceLearns(),
      }),
    );
    const at = new Date().toISOString();
    const overdue = backstops.results["autopilot-overdue"] ?? [];
    const queued = backstops.results["sends-overdue"] ?? [];
    const unsorted = backstops.results["unsorted-sweep"] ?? [];
    const voice = backstops.results.voice ?? [];
    const events = [
      ...overdue.map((draftId) => autopilotSendRequested.create({ draftId, at })),
      ...queued.map((draftId) => draftSendQueued.create({ draftId, at })),
      ...unsorted.map((mailboxId) => mailboxClassifyRequested.create({ mailboxId })),
      ...voice.map((workspaceId) => voiceLearnRequested.create({ workspaceId })),
    ];
    if (events.length) await step.sendEvent("backstop-events", events);
    // Before the alerts: the lead-at-risk pushes read what the M7 backfill fixes (A29).
    const housekeeping = await step.run("housekeeping", () =>
      runChecks({
        // One-shot M7 data fix, from new code once it's live (no-op after the first run).
        "m7-backfill": () => runM7Backfill(),
        // One-shot: drop Gmail drafts the old sync stored as owner mail (no-op after).
        "draft-messages-cleanup": () => runDraftMessagesCleanup(),
        // Plan #47 (off unless FEATURE_REFERRALS): settle referrals whose move to active was
        // missed, book earned free months, and end running ones (those end even with
        // referrals off).
        "referral-rewards": () => runReferralRewards(),
        // One-off: voices marked edited only by an accepted idea go back on the weekly
        // refresh (Check 24 P7; no-op after the first run).
        "voice-idea-cleanup": () => runVoiceIdeaCleanup(),
      }),
    );
    const alertChecks = await step.run("alerts", () =>
      runChecks({
        // Gmail access lost (and one reminder), so leads aren't silently missed.
        "access-lost-alerts": () => sendAccessLostAlerts(),
        // Replies package (B5 part 2): emergencies a run missed (an alert that reached no phone).
        "emergency-alerts": () => sendEmergencyAlerts(),
        // Backstop for text alerts held overnight or throttled.
        "text-alerts": () => sendLeadAlerts(),
        // New-lead pushes first: the lead-at-risk pushes share their slot (plan #34).
        "push-alerts": () => sendPushAlerts(),
        // Plan #34: a quote request waiting over 4 business hours → one phone notification.
        "lead-at-risk-pushes": () => sendLeadAtRiskPushes(),
        // Round 2 (FW D4): backstop for "your first drafts are ready" (once ever per account).
        "first-drafts-ready": () => sendFirstDraftsReady(),
        // 2026-10-16: the trial's day-2 and day-3 emails and the one a week after it ran out,
        // each once ever, at the owner's morning hour or later in their zone (never at night).
        "trial-emails": () => sendTrialEmails(),
        // Check 1 P4: the deep health check reads this to tell whether the jobs are running.
        // Last, so it's written after every other check had its turn.
        "record-run": () => recordLifecycleRun(),
      }),
    );
    const alerts = alertChecks.results["access-lost-alerts"] ?? { sent: 0, failed: 0 };
    // Check 25 P4 + Check 18 P1: a failed check or a refused alert email fails the run only
    // now, after every step has run, so error alerts still hear about it once. Retries replay
    // the finished steps.
    const failed = [
      ...clock.failed,
      ...backstops.failed,
      ...housekeeping.failed,
      ...alertChecks.failed,
    ];
    if (failed.length) throw new LifecycleChecksFailedError(failed);
    reportAlertFailures("access", alerts);
    return {
      started: clock.results.start,
      expired: clock.results.expire,
      voiceRestarted: voice.length,
      accessAlerts: alerts.sent,
      unsortedSwept: unsorted.length,
    };
  },
);

/**
 * Until done (review B1): read the Reply-To of stored form leads and move waiting drafts off
 * the form's robot address. Its own job, one step per mailbox, so a slow Gmail mailbox never
 * delays the lifecycle job. Check 25 P4: a daily cron (a no-op once finished); while it isn't
 * finished, each run asks for the next one 15 minutes later.
 */
export const replyToBackfill = inngest.createFunction(
  {
    id: "reply-to-backfill",
    triggers: [cron("43 4 * * *"), replyToBackfillContinue],
    concurrency: { limit: 1 },
    retries: 3,
  },
  async ({ step }) => {
    const ids = await step.run("mailboxes", () => replyToBackfillMailboxes());
    if (!ids) return { ran: false };
    const results: MailboxBackfillResult[] = [];
    for (const id of ids) {
      results.push(
        await step.run(`reply-to-backfill:${id}`, () =>
          politely(() => runReplyToBackfillMailbox(id)),
        ),
      );
    }
    const done = await step.run("finish", () => finishReplyToBackfill(results));
    if (!done)
      await step.sendEvent(
        "continue",
        replyToBackfillContinue.create({ run: Date.now() }, { ts: Date.now() + 15 * 60_000 }),
      );
    return { ran: true, done };
  },
);

/**
 * Round 2 (FW D2): the owner's "Draft them" on found money. One thread per step; every result
 * is a draft in the queue, nothing is sent. Stops at the AI cap or lost Google access.
 */
export const foundMoneyDrafts = inngest.createFunction(
  {
    id: "found-money-drafts",
    triggers: [foundMoneyDraftsRequested],
    concurrency: { key: "event.data.workspaceId", limit: 1 },
    retries: 3,
  },
  async ({ event, step }) => {
    const { workspaceId, replies, nudges } = event.data;
    const jobs = [
      ...replies.map((id) => ({ id, kind: "reply" as const })),
      ...nudges.map((id) => ({ id, kind: "nudge" as const })),
    ];
    let created = 0;
    for (const j of jobs) {
      const r = await step.run(`draft-${j.kind}-${j.id}`, () =>
        stopIfModelMissing(() => politely(() => draftFoundMoneyThread(workspaceId, j.id, j.kind))),
      );
      if (r.status === "created") created++;
      if (r.status === "reconnect_needed" || (r.status === "skipped" && r.reason === "capped"))
        break;
    }
    return { created };
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
    // And what each edit did (counts only), for "ideas from your edits" (plan #21).
    await step.run("capture-edit-signals", () => captureEditSignals());
    const purged = await step.run("purge", () => purgeExpiredBodies());
    // Gmail unit minutes (Check 25 P1) go in the same step: no extra execution.
    await step.run("purge-rate-limits", async () => {
      await purgeRateLimits();
      await purgeGmailUnits();
      await purgeJobRuns();
    });
    await step.run("purge-expired-notes", () => purgeExpiredNotes());
    // Plan #45: tell Davi when an account's AI cost passes 40% of its plan.
    const costAlerts = await step.run("cost-alerts", () => sendCostAlerts());
    await step.run("purge-cost-markers", () => purgeCostAlertMarkers());
    await step.run("purge-voice-alert-markers", () => purgeVoiceAlertMarkers());
    await step.run("purge-email-sent-records", () => purgeEmailSentRecords());
    await step.run("purge-draft-claims", () => purgeStaleDraftClaims());
    await step.run("purge-admin-notices", () => purgeAdminNoticeMarkers());
    // Check 18 P1: as in the lifecycle job, fail only after every step has run.
    reportAlertFailures("cost", costAlerts);
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
  sendAfterUndo,
  voiceIdeas,
  replyToBackfill,
  foundMoneyDrafts,
];
