import "server-only";
import { and, count, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, drafts, mailboxes } from "@/db/schema";

/** How many drafts the owner should look at before the checklist calls itself done. */
export const DRAFTS_TO_CHECK = 3;

export type ChecklistStep = {
  key: "gmail" | "profile" | "drafts" | "plan";
  label: string;
  done: boolean;
  detail?: string;
  /** A short line under the label (round 2, FW E6). */
  hint?: string;
  href: string;
};
export type Checklist = { steps: ChecklistStep[]; allDone: boolean; show: boolean };

/** Check 9 P13: a finished list goes away by itself this long after it was first all done. */
export const CHECKLIST_DONE_HIDE_MS = 3 * 24 * 60 * 60 * 1000;

/** Pure: the checklist from facts (plan #39). Each step ticks itself; nothing to tick by hand. */
export function buildChecklist(f: {
  mailboxes: number;
  profileCompleted: boolean;
  draftsChecked: number;
  dismissed: boolean;
  /** Check 9 P13: when every step was first all done (null: not yet, or a step un-did). */
  doneAt?: Date | null;
  now?: Date;
  /**
   * Round 2 (FW E7): the account is read-only (the three days ran out, or the plan stopped).
   * Drafts can't be checked then, so that step becomes what to do next.
   */
  readOnly?: boolean;
}): Checklist {
  const steps: ChecklistStep[] = [
    { key: "gmail", label: "Connect Gmail", done: f.mailboxes > 0, href: "/connect" },
    {
      key: "profile",
      label: "Tell us what you do",
      done: f.profileCompleted,
      href: "/settings/profile",
    },
    f.readOnly && f.draftsChecked < DRAFTS_TO_CHECK
      ? {
          key: "plan",
          label: "Choose a plan to keep going",
          done: false,
          hint: "Your drafts are waiting. Or call us first.",
          href: "/billing",
        }
      : {
          key: "drafts",
          label: `Check your first ${DRAFTS_TO_CHECK} drafts`,
          done: f.draftsChecked >= DRAFTS_TO_CHECK,
          detail: `${Math.min(f.draftsChecked, DRAFTS_TO_CHECK)} of ${DRAFTS_TO_CHECK}`,
          hint: "Send, edit or discard each one, or send yourself a practice copy.",
          href: "/queue#drafts",
        },
  ];
  const allDone = steps.every((s) => s.done);
  // Check 9 P13: all done for 3 days → gone on its own (Hide still works sooner).
  const aged =
    !!f.doneAt && (f.now ?? new Date()).getTime() - f.doneAt.getTime() >= CHECKLIST_DONE_HIDE_MS;
  return { steps, allDone, show: !(allDone && (f.dismissed || aged)) };
}

/**
 * A draft counts as checked once the owner did something with it: sent it,
 * discarded it, or edited it — or, during the three days, sent themselves a practice copy of it
 * (round 2, FW E6: that's the trial's main action). Each draft counts once.
 */
export async function checklistFor(
  workspaceId: string,
  opts: { readOnly?: boolean; now?: Date } = {},
): Promise<Checklist> {
  const now = opts.now ?? new Date();
  const [boxes] = await db()
    .select({ n: count() })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  const [profile] = await db()
    .select({
      completedAt: businessProfiles.completedAt,
      dismissedAt: businessProfiles.onboardingDismissedAt,
      doneAt: businessProfiles.onboardingDoneAt,
    })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const acted = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        or(
          inArray(drafts.status, ["sent", "edited_and_sent", "discarded"]),
          ne(drafts.body, sql`${drafts.originalBody}`),
        ),
      ),
    );
  const practiced = await db()
    .select({ id: sql<string | null>`${activityLog.detail}->>'draftId'` })
    .from(activityLog)
    .where(and(eq(activityLog.workspaceId, workspaceId), eq(activityLog.action, "practice_sent")));
  const checked = new Set([
    ...acted.map((r) => r.id),
    ...practiced.flatMap((r) => (r.id ? [r.id] : [])),
  ]);
  const facts = {
    mailboxes: boxes?.n ?? 0,
    profileCompleted: !!profile?.completedAt,
    draftsChecked: checked.size,
    dismissed: !!profile?.dismissedAt,
    readOnly: opts.readOnly,
  };
  const allDone = buildChecklist(facts).allDone;
  // Check 9 P13: remember when it was first all done; forget it when a step un-does, so the
  // full list comes back (and the 3 days start again once it's finished again).
  let doneAt = profile?.doneAt ?? null;
  if (allDone && !doneAt) {
    doneAt = now;
    await db()
      .insert(businessProfiles)
      .values({ workspaceId, onboardingDoneAt: now })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set: {
          onboardingDoneAt: sql`coalesce(${businessProfiles.onboardingDoneAt}, excluded.onboarding_done_at)`,
        },
      });
  } else if (!allDone && doneAt) {
    doneAt = null;
    await db()
      .update(businessProfiles)
      .set({ onboardingDoneAt: null })
      .where(eq(businessProfiles.workspaceId, workspaceId));
  }
  return buildChecklist({ ...facts, doneAt, now });
}

/** Only once every step is done — the server re-checks. */
export async function dismissChecklist(workspaceId: string, now = new Date()): Promise<boolean> {
  const list = await checklistFor(workspaceId);
  if (!list.allDone) return false;
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, onboardingDismissedAt: now })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: { onboardingDismissedAt: now },
    });
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "checklist_dismissed", detail: {} });
  return true;
}
