import "server-only";
import { and, asc, count, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activityLog, businessProfiles, seasonalNotes } from "@/db/schema";
import { localParts } from "./digest";

/** Seasonal notes (plan #25). */
export const MAX_ACTIVE_NOTES = 5;
export const NOTE_MAX_CHARS = 140;
/** Notes can't be set further out than this — they're meant to be seasonal. */
export const NOTE_MAX_DAYS_AHEAD = 366;

export const seasonalNoteInput = z.object({
  text: z
    .string()
    .trim()
    .min(3, "Write a short note, like “Booked through November”.")
    .max(NOTE_MAX_CHARS, `Keep it under ${NOTE_MAX_CHARS} characters.`),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the last day this applies."),
});

export class SeasonalNoteError extends Error {
  constructor(
    readonly code: "past" | "too_far" | "full",
    message: string,
  ) {
    super(message);
    this.name = "SeasonalNoteError";
  }
}

/** Today in the owner's time zone, YYYY-MM-DD. */
export async function ownerToday(workspaceId: string, now: Date = new Date()) {
  const [p] = await db()
    .select({ timeZone: businessProfiles.timeZone })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return localParts(now, p?.timeZone ?? "America/New_York").date;
}

/** Notes whose last day is today or later. Expired ones never reach a prompt. */
export async function activeNotes(workspaceId: string, now: Date = new Date()) {
  const today = await ownerToday(workspaceId, now);
  return db()
    .select({ id: seasonalNotes.id, text: seasonalNotes.text, endsOn: seasonalNotes.endsOn })
    .from(seasonalNotes)
    .where(and(eq(seasonalNotes.workspaceId, workspaceId), gte(seasonalNotes.endsOn, today)))
    .orderBy(asc(seasonalNotes.endsOn))
    .limit(MAX_ACTIVE_NOTES);
}

function addDays(ymd: string, days: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function addSeasonalNote(
  workspaceId: string,
  input: z.output<typeof seasonalNoteInput>,
  now: Date = new Date(),
) {
  const today = await ownerToday(workspaceId, now);
  if (input.endsOn < today) throw new SeasonalNoteError("past", "That date has already passed.");
  if (input.endsOn > addDays(today, NOTE_MAX_DAYS_AHEAD)) {
    throw new SeasonalNoteError("too_far", "Pick a date within the next year.");
  }
  const [active] = await db()
    .select({ n: count() })
    .from(seasonalNotes)
    .where(and(eq(seasonalNotes.workspaceId, workspaceId), gte(seasonalNotes.endsOn, today)));
  if ((active?.n ?? 0) >= MAX_ACTIVE_NOTES) {
    throw new SeasonalNoteError(
      "full",
      `You can have ${MAX_ACTIVE_NOTES} notes at once. Remove one first.`,
    );
  }
  await db().insert(seasonalNotes).values({ workspaceId, text: input.text, endsOn: input.endsOn });
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "seasonal_note_added", detail: {} });
}

export async function removeSeasonalNote(workspaceId: string, id: string) {
  const gone = await db()
    .delete(seasonalNotes)
    .where(and(eq(seasonalNotes.id, id), eq(seasonalNotes.workspaceId, workspaceId)))
    .returning({ id: seasonalNotes.id });
  return gone.length > 0;
}

/** Daily tidy-up: expired notes have no use. */
export async function purgeExpiredNotes(now: Date = new Date()) {
  // Two days' slack covers every US time zone.
  const cutoff = addDays(now.toISOString().slice(0, 10), -2);
  await db().delete(seasonalNotes).where(lt(seasonalNotes.endsOn, cutoff));
}
