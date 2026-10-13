import "server-only";
import { desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { tradeEnum, waitlist } from "@/db/schema";
import { inviteOwner } from "./admin";
import { normalizeEmail } from "./accounts";
import {
  describeWaitlistEntry,
  GROWTH_MARK,
  GROWTH_ONLY_TEAM_SIZE,
  growthBlocksText,
  scrubMarker,
} from "./growth-note";

export const TEAM_SIZES = ["Just me", "2–5", "6–15", "16+"] as const;

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .transform((v) => v || null)
    .nullable()
    .optional();

/** Plain-language messages: this form is the first thing a contractor fills in. */
export const waitlistInput = z.object({
  name: z.string().trim().min(1, "Tell us your name.").max(120, "That name is too long."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Tell us your email address.")
    .max(254, "That doesn't look like an email address. Use the Gmail you run the business from.")
    .email("That doesn't look like an email address. Use the Gmail you run the business from."),
  phone: optional(40),
  trade: z.enum(tradeEnum.enumValues, { message: "Pick your trade." }),
  teamSize: z.enum(TEAM_SIZES, { message: "Pick how many people work with you." }),
  note: optional(1000),
});

/**
 * Idempotent: signing up twice keeps the first entry. The one exception is an entry that
 * exists only because of a Squared Away Growth call request: joining the app waitlist turns it
 * into a real sign-up (their team size, blanks filled in, the app note before the Growth block).
 */
export async function joinWaitlist(input: z.output<typeof waitlistInput>) {
  const email = normalizeEmail(input.email);
  const note = input.note ? scrubMarker(input.note) : null;
  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(waitlist)
      .values({ ...input, email, note })
      .onConflictDoNothing()
      .returning({ email: waitlist.email });
    if (row) return "joined" as const;
    const [existing] = await tx
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, email))
      .for("update");
    if (!existing || existing.teamSize !== GROWTH_ONLY_TEAM_SIZE) return "already" as const;
    await tx
      .update(waitlist)
      .set({
        teamSize: input.teamSize,
        trade: existing.trade ?? input.trade,
        // The growth-only row's phone came from Growth and is still in its block; this column
        // now holds only what the app form was given (so a later Growth request can't leave an
        // old number behind here).
        phone: input.phone ?? null,
        note: [note, growthBlocksText(existing.note)].filter(Boolean).join("\n\n") || null,
      })
      .where(eq(waitlist.email, email));
    return "joined" as const;
  });
}

/**
 * The newest entries plus every entry carrying a Growth call request (so a request added to an
 * old app entry always shows), newest activity first.
 */
export async function listWaitlist(limit = 200) {
  const [newest, growth] = await Promise.all([
    db().select().from(waitlist).orderBy(desc(waitlist.createdAt)).limit(limit),
    db()
      .select()
      .from(waitlist)
      .where(like(waitlist.note, `%${GROWTH_MARK} %`))
      .orderBy(desc(waitlist.createdAt))
      .limit(limit),
  ]);
  const byEmail = new Map(newest.map((r) => [r.email, r]));
  for (const r of growth) byEmail.set(r.email, r);
  return [...byEmail.values()]
    .map((row) => ({ row, stamp: describeWaitlistEntry(row).latestStamp }))
    .sort(
      (a, b) =>
        b.stamp.localeCompare(a.stamp) || b.row.createdAt.getTime() - a.row.createdAt.getTime(),
    )
    .map((x) => x.row);
}

/**
 * Davi's "Invite" on a waitlist entry: adds them to the invite list and marks it done. A
 * Growth-only entry is never invited (a Growth call isn't an app sign-up), and the invite carries
 * the app note only, never the Growth request.
 */
export async function inviteFromWaitlist(email: string, now: Date = new Date()) {
  const [entry] = await db()
    .select()
    .from(waitlist)
    .where(eq(waitlist.email, normalizeEmail(email)));
  if (!entry) return "not_found" as const;
  const facts = describeWaitlistEntry(entry);
  if (!facts.app) return "growth_only" as const;
  await inviteOwner({ email: entry.email, trade: entry.trade, note: facts.appNote });
  await db().update(waitlist).set({ invitedAt: now }).where(eq(waitlist.email, entry.email));
  return "invited" as const;
}
