import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles } from "@/db/schema";

/** The owner's "Never say this" list (plan #23): words drafts must not use. */
export const NEVER_SAY_MAX = 50;
export const NEVER_SAY_PHRASE = { min: 2, max: 80 } as const;

export class NeverSayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeverSayError";
  }
}

/** Trim, drop blanks and too-long lines, de-dupe ignoring case, cap the count. */
export function cleanNeverSay(lines: string[]): string[] {
  return cleanNeverSayCounted(lines).list;
}

/**
 * Check 15 P5: the same, counting the lines dropped for their length or past the 50th, so the
 * owner is told. Blank lines and repeats aren't counted (nothing was lost).
 */
export function cleanNeverSayCounted(lines: string[]): { list: string[]; skipped: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (p.length < NEVER_SAY_PHRASE.min || p.length > NEVER_SAY_PHRASE.max) {
      skipped++;
      continue;
    }
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  skipped += Math.max(0, out.length - NEVER_SAY_MAX);
  return { list: out.slice(0, NEVER_SAY_MAX), skipped };
}

async function current(workspaceId: string) {
  const [p] = await db()
    .select({ neverSay: businessProfiles.neverSay })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return p?.neverSay ?? [];
}

async function save(workspaceId: string, list: string[]) {
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, neverSay: list })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: { neverSay: list } });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "never_say_saved",
      detail: { count: list.length },
    });
}

/** Replace the whole list (Settings textarea, one per line). Counts only come back. */
export async function saveNeverSay(workspaceId: string, text: string) {
  const { list, skipped } = cleanNeverSayCounted(text.split("\n"));
  await save(workspaceId, list);
  return { saved: list.length, skipped };
}

/** Add one phrase (from the draft editor: select words → Never say this). */
export async function addNeverSay(workspaceId: string, phrase: string) {
  const p = phrase.replace(/\s+/g, " ").trim();
  if (p.length < NEVER_SAY_PHRASE.min) throw new NeverSayError("Select the words first.");
  if (p.length > NEVER_SAY_PHRASE.max) throw new NeverSayError("Pick a shorter phrase.");
  const list = await current(workspaceId);
  if (list.length >= NEVER_SAY_MAX && !list.some((x) => x.toLowerCase() === p.toLowerCase())) {
    throw new NeverSayError("Your never-say list is full. Remove one in Settings first.");
  }
  const next = cleanNeverSay([...list, p]);
  await save(workspaceId, next);
  return next;
}
