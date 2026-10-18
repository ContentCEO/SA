import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";
import { leadPlatformOf, leadSourceOf } from "./monthly-rules";
import { LEAD_PAY_DAYS, leadPayRows, WEBSITE_FORM, type LeadPayRow } from "./quote-rules";
import {
  noReplySql,
  quoteRequestSql,
  requestAtSql,
  requestReplySql,
  requestSenderSql,
} from "./thread-sql";

/**
 * Ideas K2: which lead sources pay, from the last 90 days of quote requests. Only the
 * requester's DOMAIN leaves the database (cut out in SQL), plus yes/no and the outcome — never
 * an address or a name. Owner-only (the Quotes screen); never in emails, admin, push or texts.
 */
export async function leadSourcePay(
  workspaceId: string,
  now: Date = new Date(),
): Promise<LeadPayRow[] | null> {
  const since = new Date(now.getTime() - LEAD_PAY_DAYS * 86_400_000).toISOString();
  const sender = requestSenderSql();
  const rows = await db()
    .select({
      domain: sql<
        string | null
      >`(case when position('@' in coalesce(${sender}, '')) > 0 then regexp_replace(lower(trim(${sender})), '^.*@', '') end)`,
      // A contact form's robot (no-reply From) carrying the customer in Reply-To.
      websiteForm: sql<boolean>`coalesce(${noReplySql(sender)} and ${requestReplySql()} is distinct from lower(trim(${sender})), false)`,
      outcome: threads.quoteOutcome,
      outcomeSource: threads.quoteOutcomeSource,
      amountCents: threads.quoteAmountCents,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        quoteRequestSql(),
        sql`${requestAtSql()} >= ${since}::timestamptz`,
      ),
    );
  return leadPayRows(
    rows.map((r) => {
      const platform = leadPlatformOf(r.domain);
      return {
        label: platform ?? (r.websiteForm ? WEBSITE_FORM : leadSourceOf(r.domain)),
        offEmail: platform != null,
        outcome: r.outcome,
        outcomeSource: r.outcomeSource,
        amountCents: r.amountCents,
      };
    }),
  );
}
