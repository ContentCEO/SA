import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, seasonalNotes } from "@/db/schema";
import {
  awayActive,
  awayEndsOn,
  awayNoteText,
  validateBackOn,
  type BackOnCheck,
} from "./away-rules";
import { localParts, usableTimeZone } from "./snooze-rules";
import { effectiveStatus, jobsAllowed, ReadOnlyError } from "./lifecycle";
import type { Workspace } from "@/db/schema";

/** Ideas E7: the owner's away state, read at use (no job turns it off). */
export async function awayState(workspaceId: string, now: Date = new Date()) {
  const [p] = await db()
    .select({ backOn: businessProfiles.awayBackOn, timeZone: businessProfiles.timeZone })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const tz = usableTimeZone(p?.timeZone);
  const today = localParts(now, tz).date;
  const on = awayActive(p?.backOn, today);
  return { on, backOn: on ? p!.backOn! : null, today, timeZone: tz };
}

export async function isAway(workspaceId: string, now: Date = new Date()) {
  return (await awayState(workspaceId, now)).on;
}

/**
 * Turn away mode on: the day back, and the one away note drafts read ("Away until … Back …").
 * "Today" is the owner's own (their stored zone, or the browser's when still the default).
 */
export async function turnAwayOn(
  workspace: Pick<Workspace, "id" | "status" | "evaluationEndsAt">,
  backOn: unknown,
  opts: { timeZone?: string | null; now?: Date } = {},
): Promise<BackOnCheck> {
  const now = opts.now ?? new Date();
  if (!jobsAllowed(workspace, now)) throw new ReadOnlyError(effectiveStatus(workspace, now));
  await db().insert(businessProfiles).values({ workspaceId: workspace.id }).onConflictDoNothing();
  const [p] = await db()
    .select({ timeZone: businessProfiles.timeZone })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspace.id));
  const stored = usableTimeZone(p?.timeZone);
  const posted =
    opts.timeZone && usableTimeZone(opts.timeZone) === opts.timeZone ? opts.timeZone : null;
  // A new owner's zone may still be the default; the browser's own zone decides "today" then.
  const tz = stored === "America/New_York" && posted ? posted : stored;
  const today = localParts(now, tz).date;
  const check = validateBackOn(backOn, today);
  if (check !== "ok") return check;
  const day = backOn as string;
  await db().transaction(async (tx) => {
    await tx
      .update(businessProfiles)
      .set({
        awayBackOn: day,
        ...(tz !== stored ? { timeZone: tz } : {}),
        updatedAt: now,
      })
      .where(eq(businessProfiles.workspaceId, workspace.id));
    await tx
      .delete(seasonalNotes)
      .where(and(eq(seasonalNotes.workspaceId, workspace.id), eq(seasonalNotes.away, true)));
    await tx.insert(seasonalNotes).values({
      workspaceId: workspace.id,
      text: awayNoteText(day),
      endsOn: awayEndsOn(day),
      away: true,
    });
    await tx.insert(activityLog).values({
      workspaceId: workspace.id,
      actor: "owner",
      action: "away_on",
      detail: {
        days: Math.round(
          (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000,
        ),
      },
    });
  });
  return "ok";
}

/** "I'm back": away mode off now, its note gone. */
export async function turnAwayOff(workspaceId: string, now: Date = new Date()) {
  await db().transaction(async (tx) => {
    await tx
      .update(businessProfiles)
      .set({ awayBackOn: null, updatedAt: now })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    await tx
      .delete(seasonalNotes)
      .where(and(eq(seasonalNotes.workspaceId, workspaceId), eq(seasonalNotes.away, true)));
    await tx
      .insert(activityLog)
      .values({ workspaceId, actor: "owner", action: "away_off", detail: {} });
  });
}
