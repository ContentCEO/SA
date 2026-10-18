import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { mailboxes, workspaces } from "@/db/schema";
import { considerAutopilot } from "@/server/autopilot";
import { classifyPending } from "@/server/classification";
import {
  createDraftForThread,
  deliverQueuedSend,
  reconcileDrafts,
  threadsToAutoDraft,
} from "@/server/drafts";
import { jobsAllowed } from "@/server/lifecycle";
import { quoteUpkeepForMailbox } from "@/server/quotes";
import { incrementalSync, runBackfill } from "@/server/sync";
import { learnVoice } from "@/server/voice";

/**
 * The job steps, run on request for the local end-to-end test (Milestone 11), since Inngest
 * isn't there. Reached only through /api/test-hooks/run, which is a 404 unless the app is in
 * local e2e mode (src/config/e2e.ts) with the hook secret.
 *
 * Each step calls the same functions the Inngest job calls (src/jobs/functions.ts), in the
 * same order, with no injected deps and the real clock — so every gate (jobsAllowed, mailbox
 * status, canSend, the AI cap, gaps, the undo window) runs exactly as in production. Nothing
 * here schedules a send: 'draft' records an autopilot countdown like the job does but never
 * sends it, and 'deliver' only sends a draft whose undo window has really passed.
 *
 * Returns ids, statuses and counts only — never text, names or addresses.
 */

const uuid = z.uuid();
export const hookStep = z.discriminatedUnion("step", [
  z.object({ step: z.literal("backfill"), mailboxId: uuid }),
  z.object({ step: z.literal("sync"), mailboxId: uuid }),
  z.object({ step: z.literal("voice"), workspaceId: uuid }),
  z.object({ step: z.literal("classify"), mailboxId: uuid }),
  z.object({ step: z.literal("draft"), mailboxId: uuid }),
  z.object({ step: z.literal("deliver"), draftId: uuid }),
  // Check 29 P7: the draft job's quote upkeep on its own (amounts, "no answer" guesses).
  z.object({ step: z.literal("quote-upkeep"), mailboxId: uuid }),
]);
export type HookStep = z.infer<typeof hookStep>;

/** `ok` is false whenever the step didn't do its job; the route then answers 409, never 200. */
export type HookResult = { ok: boolean } & Record<string, unknown>;

/** Same rounds as classifyMailbox. */
const CLASSIFY_ROUNDS = 50;

/**
 * Why the 'draft' step can't run for this mailbox at all, in createDraftForThread's words.
 * reconcileDrafts and threadsToAutoDraft just return nothing then, which would look like
 * "nothing due" — so the step says it out loud instead.
 */
async function draftBlockedReason(mailboxId: string) {
  const [row] = await db()
    .select({ mailboxStatus: mailboxes.status, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  if (!row) return "not_found" as const;
  if (!jobsAllowed(row.workspace)) return "read_only" as const;
  if (row.mailboxStatus !== "active") return "mailbox_inactive" as const;
  return null;
}

export async function runHookStep(input: HookStep): Promise<HookResult> {
  switch (input.step) {
    case "backfill": {
      // runBackfill = beginBackfill → every page → finishBackfill, stopping at the first
      // outcome that isn't ok (the job's own sequence; finish never runs after a skip).
      const r = await runBackfill(input.mailboxId);
      return { ok: r.status === "ok", ...r };
    }
    case "sync": {
      const r = await incrementalSync(input.mailboxId);
      return { ok: r.status === "ok", ...r };
    }
    case "voice": {
      const status = await learnVoice(input.workspaceId);
      return { ok: status === "ready", status };
    }
    case "classify": {
      let classified = 0;
      for (let round = 0; round < CLASSIFY_ROUNDS; round++) {
        const r = await classifyPending(input.mailboxId, { limit: 10 });
        classified += r.classified;
        if (r.capped || r.remaining === 0)
          return { ok: !r.capped, classified, capped: r.capped, remaining: r.remaining };
      }
      return { ok: false, classified, capped: false, reason: "too_many_rounds" };
    }
    case "draft": {
      const blocked = await draftBlockedReason(input.mailboxId);
      if (blocked) return { ok: false, status: "skipped", reason: blocked };
      const reconciled = await reconcileDrafts(input.mailboxId);
      await quoteUpkeepForMailbox(input.mailboxId);
      const due = await threadsToAutoDraft(input.mailboxId, 10);
      const outcomes: Record<string, unknown>[] = [];
      // Every due thread must get its draft: any other outcome (model_failed, no_text…) is a
      // failure here, with each thread's status and reason in the body.
      let ok = true;
      for (const threadId of due) {
        const r = await createDraftForThread(threadId, { trigger: "auto" });
        if (r.status === "created") {
          const autoSendAt = await considerAutopilot(r.draftId);
          outcomes.push({ threadId, status: r.status, draftId: r.draftId, autoSendAt });
          continue;
        }
        ok = false;
        outcomes.push({ threadId, ...r });
        // The job stops here too.
        if (r.status === "reconnect_needed" || (r.status === "skipped" && r.reason === "capped"))
          break;
      }
      return {
        ok,
        reconciled: { checked: reconciled.checked, closed: reconciled.closed },
        created: outcomes.filter((o) => o.status === "created").length,
        drafts: outcomes,
      };
    }
    case "quote-upkeep": {
      const r = await quoteUpkeepForMailbox(input.mailboxId);
      return { ok: true, ...r };
    }
    case "deliver": {
      // The real clock: 'not_due' until the undo window has passed.
      const r = await deliverQueuedSend(input.draftId);
      return { ok: r.status === "sent", ...r };
    }
  }
}
