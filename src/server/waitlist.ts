import "server-only";
import { desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { tradeLabel } from "@/config/trades";
import { invites, tradeEnum, users, waitlist } from "@/db/schema";
import { inviteOwner } from "./admin";
import { inviteForEmails, normalizeEmail } from "./accounts";
import {
  describeWaitlistEntry,
  GROWTH_MARK,
  GROWTH_ONLY_TEAM_SIZE,
  growthBlocksText,
  scrubMarker,
  splitWaitlistNote,
  withBlockTradeGiven,
} from "./growth-note";
import { isReferralCode, referralsVisible } from "./referral-rules";
import { firstTouch, NO_SOURCE, type SignupSource } from "./source-rules";
import { workspaceByReferralCode } from "./referrals";

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
    .max(254, "That doesn't look like an email address.")
    .email("That doesn't look like an email address."),
  phone: optional(40),
  trade: z.enum(tradeEnum.enumValues, { message: "Pick your trade." }),
  teamSize: z.enum(TEAM_SIZES, { message: "Pick how many people work with you." }),
  note: optional(1000),
  /** Plan #47: the code from a referral link (?ref=). Anything malformed is dropped, not an error. */
  referralCode: z
    .unknown()
    .optional()
    .transform((v) => (isReferralCode(v) ? v : null)),
});

/**
 * Idempotent: signing up twice keeps the first entry. The one exception is an entry that
 * exists only because of a Squared Away Growth call request: joining the app waitlist turns it
 * into a real sign-up (their team size and trade from the app form, blanks filled in, the app
 * note before the Growth block).
 */
export async function joinWaitlist(
  input: z.output<typeof waitlistInput>,
  source: SignupSource = NO_SOURCE,
) {
  const email = normalizeEmail(input.email);
  const note = input.note ? scrubMarker(input.note) : null;
  // Plan #47: kept only while referrals are switched on (flag and amount).
  const referralCode = referralsVisible() ? (input.referralCode ?? null) : null;
  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(waitlist)
      .values({ ...input, email, note, referralCode, ...source })
      .onConflictDoNothing()
      .returning({ email: waitlist.email });
    if (row) return "joined" as const;
    const [existing] = await tx
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, email))
      .for("update");
    if (!existing || existing.teamSize !== GROWTH_ONLY_TEAM_SIZE) return "already" as const;
    // The app form's trade is what the invite and the new workspace use. The trade they gave
    // Growth (the block's "Trade given", else the row's) stays in the Growth block when it differs.
    const growthTrade =
      splitWaitlistNote(existing.note).growth[0]?.tradeGiven ??
      (existing.trade ? tradeLabel[existing.trade] : null);
    const blocks = withBlockTradeGiven(
      growthBlocksText(existing.note),
      growthTrade && growthTrade !== tradeLabel[input.trade] ? growthTrade : null,
    );
    await tx
      .update(waitlist)
      .set({
        teamSize: input.teamSize,
        trade: input.trade,
        // The growth-only row's phone came from Growth and is still in its block; this column
        // now holds only what the app form was given (so a later Growth request can't leave an
        // old number behind here).
        phone: input.phone ?? null,
        // A Growth request never carries a referral; the app sign-up that upgrades it may.
        referralCode: existing.referralCode ?? referralCode,
        note: [note, blocks].filter(Boolean).join("\n\n") || null,
        ...firstTouch(existing, source),
      })
      .where(eq(waitlist.email, email));
    return "joined" as const;
  });
}

/**
 * Where a waitlist entry stands with sign-in, read from the invite list itself, not only from
 * `waitlist.invited_at` (that only says Davi once tapped Invite). Delete my account removes the
 * owner's invite but keeps the waitlist entry, so a deleted owner's entry is `invite_gone`: the
 * card offers Invite again instead of a stale "Invited".
 */
export type WaitlistInviteState = "not_invited" | "invited" | "has_account" | "invite_gone";

export function waitlistInviteState(input: {
  invitedAt: Date | null;
  inviteExists: boolean;
  hasAccount: boolean;
}): WaitlistInviteState {
  if (input.inviteExists) return "invited";
  if (input.hasAccount) return "has_account";
  return input.invitedAt ? "invite_gone" : "not_invited";
}

/**
 * The newest entries plus every entry carrying a Growth call request (so a request added to an
 * old app entry always shows), newest activity first. Each carries its `inviteState` (and the
 * live invite's date, when there is one).
 */
export async function listWaitlist(limit = 200) {
  const rows = await waitlistRows(limit);
  const emails = [...new Set(rows.map((r) => normalizeEmail(r.email)))];
  const [inviteRows, userRows] = emails.length
    ? await Promise.all([
        db()
          .select({ email: invites.email, invitedAt: invites.invitedAt })
          .from(invites)
          .where(inviteForEmails(emails)),
        db()
          .select({ email: sql<string>`lower(${users.email})` })
          .from(users)
          .where(inArray(sql`lower(${users.email})`, emails)),
      ])
    : [[], []];
  const inviteAt = new Map(inviteRows.map((r) => [r.email, r.invitedAt]));
  const accounts = new Set(userRows.map((r) => r.email));
  return rows.map((row) => {
    const e = normalizeEmail(row.email);
    return {
      ...row,
      inviteState: waitlistInviteState({
        invitedAt: row.invitedAt,
        inviteExists: inviteAt.has(e),
        hasAccount: accounts.has(e),
      }),
      inviteAt: inviteAt.get(e) ?? null,
    };
  });
}

async function waitlistRows(limit: number) {
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
  // Plan #47: carry the referral only while referrals are on; an unknown code is ignored.
  const referredByWorkspaceId = referralsVisible()
    ? await workspaceByReferralCode(entry.referralCode)
    : null;
  await inviteOwner({
    email: entry.email,
    trade: entry.trade,
    note: facts.appNote,
    referredByWorkspaceId,
  });
  await db().update(waitlist).set({ invitedAt: now }).where(eq(waitlist.email, entry.email));
  return "invited" as const;
}
