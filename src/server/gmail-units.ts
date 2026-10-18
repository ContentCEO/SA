import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { gmailUnits, mailboxes } from "@/db/schema";
import { MailboxRateLimitError } from "@/mailbox/connector";
import {
  GMAIL_UNITS,
  GMAIL_UNITS_PER_MINUTE,
  minuteStart,
  nextMinute,
  type GmailBudget,
  type GmailMethod,
} from "@/mailbox/gmail/quota";

/** How long a client trusts its last look at `mailboxes.gmail_cool_until`. */
const COOL_RECHECK_MS = 15_000;

/**
 * Check 25 P1: the shared per-mailbox Gmail unit budget. Every request reserves its units with
 * one atomic upsert (same pattern as rate-limit.ts); a reservation that would pass 5,400 in the
 * current minute is refused and the call throws MailboxRateLimitError with retryAt = the next
 * minute, so `politely()` pauses the step instead of hammering Google.
 *
 * A cool-down Gmail named (`gmail_cool_until`) stops every call before any fetch until then.
 */
export function gmailBudgetFor(
  mailboxId: string,
  clock: () => Date = () => new Date(),
): GmailBudget {
  let coolUntil: Date | null = null;
  let coolCheckedAt = 0;

  async function currentCool(now: Date): Promise<Date | null> {
    if (now.getTime() - coolCheckedAt >= COOL_RECHECK_MS) {
      const [row] = await db()
        .select({ until: mailboxes.gmailCoolUntil })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId));
      coolUntil = row?.until ?? null;
      coolCheckedAt = now.getTime();
    }
    return coolUntil;
  }

  return {
    async reserve(method: GmailMethod) {
      const now = clock();
      const cool = await currentCool(now);
      if (cool && cool.getTime() > now.getTime()) {
        throw new MailboxRateLimitError("Gmail asked us to wait before reading this inbox.", cool);
      }
      const units = GMAIL_UNITS[method];
      const [row] = await db()
        .insert(gmailUnits)
        .values({ mailboxId, minute: minuteStart(now), units })
        .onConflictDoUpdate({
          target: [gmailUnits.mailboxId, gmailUnits.minute],
          set: { units: sql`${gmailUnits.units} + excluded.units` },
          setWhere: sql`${gmailUnits.units} + excluded.units <= ${GMAIL_UNITS_PER_MINUTE}`,
        })
        .returning({ units: gmailUnits.units });
      if (!row) {
        throw new MailboxRateLimitError(
          "This inbox used its Gmail allowance for this minute.",
          nextMinute(now),
        );
      }
    },
    async coolUntil(at: Date) {
      coolUntil = at;
      coolCheckedAt = clock().getTime();
      // Only ever moves later: two jobs hitting the limit can't shorten each other's wait.
      await db()
        .update(mailboxes)
        .set({ gmailCoolUntil: at })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            sql`(${mailboxes.gmailCoolUntil} is null or ${mailboxes.gmailCoolUntil} < ${at.toISOString()}::timestamptz)`,
          ),
        );
    },
  };
}

/** Daily cleanup: past minutes are dead weight. */
export async function purgeGmailUnits(now = new Date()) {
  await db()
    .delete(gmailUnits)
    .where(lt(gmailUnits.minute, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
}

/** Content-free per-run log: which job, which mailbox, how many units. */
export function logGmailUnits(job: string, mailboxId: string, client: unknown) {
  const units = (client as { gmailUnits?: () => number } | null)?.gmailUnits?.();
  if (typeof units === "number" && units > 0) {
    console.info("gmail_units", { job, mailboxId, gmailUnits: units });
  }
}
