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
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (p.length < NEVER_SAY_PHRASE.min || p.length > NEVER_SAY_PHRASE.max) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, NEVER_SAY_MAX);
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

/** Replace the whole list (Settings textarea, one per line). */
export async function saveNeverSay(workspaceId: string, text: string) {
  const list = cleanNeverSay(text.split("\n"));
  await save(workspaceId, list);
  return list;
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
