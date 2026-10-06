import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { tradeEnum, waitlist } from "@/db/schema";
import { inviteOwner } from "./admin";
import { normalizeEmail } from "./accounts";

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
    .email("That doesn't look like an email address. Use the Gmail you run the business from."),
  phone: optional(40),
  trade: z
    .enum(tradeEnum.enumValues, { message: "Pick your trade." })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  teamSize: z
    .enum(TEAM_SIZES, { message: "Pick how many people work with you." })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  note: optional(1000),
});

/** Idempotent: signing up twice keeps the first entry. */
export async function joinWaitlist(input: z.output<typeof waitlistInput>) {
  const [row] = await db()
    .insert(waitlist)
    .values({ ...input, email: normalizeEmail(input.email) })
    .onConflictDoNothing()
    .returning({ email: waitlist.email });
  return row ? ("joined" as const) : ("already" as const);
}

export async function listWaitlist(limit = 100) {
  return db().select().from(waitlist).orderBy(desc(waitlist.createdAt)).limit(limit);
}

/** Davi's "Invite" on a waitlist entry: adds them to the invite list and marks it done. */
export async function inviteFromWaitlist(email: string, now: Date = new Date()) {
  const [entry] = await db()
    .select()
    .from(waitlist)
    .where(eq(waitlist.email, normalizeEmail(email)));
  if (!entry) return "not_found" as const;
  await inviteOwner({ email: entry.email, trade: entry.trade, note: entry.note });
  await db().update(waitlist).set({ invitedAt: now }).where(eq(waitlist.email, entry.email));
  return "invited" as const;
}
