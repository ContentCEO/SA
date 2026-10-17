import "server-only";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { isLeadCategory } from "@/config/categories";
import { db } from "@/db";
import { businessProfiles, mailboxes, messages, threads } from "@/db/schema";
import { findUsPhones, formatUsPhone, type E164 } from "@/lib/phone-numbers";
import { channelKind, channelName, openSiteUrl, type ChannelKind } from "./channel-rules";
import { playbookApplies } from "./complaint-rules";
import { customerPhone, firstNameOf, textPrefill } from "./contact-rules";
import { parseLeadSite, type LeadSiteFacts } from "./lead-site-rules";
import { bestEarlier, repeatLine, type EarlierJob } from "./repeat-customer-rules";
import { isNoReplyAddress } from "./sender-rules";
import { outsideArea } from "./service-area-rules";
import { notDraftSql, replyAddressSql, sideEmailSql } from "./thread-sql";

/**
 * Leads package: what a queue card adds on top of the email — Call / Text buttons (B4), the
 * lead-site or voicemail card (B2 / B3), the repeat-customer line
 * (B14) and the outside-your-area line (B9). Read at render, in a fixed number of queries
 * whatever the number of cards; nothing is stored or logged, and the number only ever reaches
 * the page inside a tel: / sms: link.
 */
export type LeadCard = {
  /** The customer's number, or null (no button row). */
  phone: E164 | null;
  /** "(508) 555-1234". */
  phoneShown: string | null;
  /** The text the phone's messages app opens with. */
  textBody: string;
  firstName: string | null;
  channel: { kind: ChannelKind; name: string; openUrl: string | null } | null;
  site: LeadSiteFacts | null;
  /** "Nashua, NH" when a quote request's town isn't on the owner's list. */
  outsideTown: string | null;
  /** Adding the town would clear the only reason this card needs the owner. */
  townClears: boolean;
  repeat: string | null;
};

export type CardInput = {
  threadId: string;
  category: string | null;
  leadChannel: string | null;
  extracted: unknown;
  customerName: string | null;
  customerAddress: string | null;
  /** Needs-you style card (no reply drafted): Call / Text buttons may show. */
  needsYou: boolean;
};

/** Cards that show Call / Text: lead categories, emergencies, complaints and lead channels. */
export const showsButtons = (c: CardInput) =>
  c.needsYou && (isLeadCategory(c.category) || c.leadChannel != null);

const REPEAT_CATEGORIES = ["quote_request", "customer_question", "scheduling"];

export async function leadCardsFor(
  workspaceId: string,
  cards: readonly CardInput[],
  opts: { now: Date; timeZone: string; businessName: string | null },
): Promise<Map<string, LeadCard>> {
  const out = new Map<string, LeadCard>();
  if (cards.length === 0) return out;
  const boxIds = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (boxIds.length === 0) return out;
  const [profile] = await db()
    .select({
      signature: businessProfiles.signature,
      alertPhone: businessProfiles.alertPhone,
      serviceTowns: businessProfiles.serviceTowns,
    })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));

  const buttonIds = cards.filter(showsButtons).map((c) => c.threadId);
  const inbound = new Map<
    string,
    { subject: string | null; body: string | null; fromAddress: string | null }[]
  >();
  const ownerNumbers = new Set<string>();
  if (buttonIds.length) {
    // The last 3 customer emails per card, in one query (B4).
    const ranked = db()
      .select({
        threadId: messages.threadId,
        subject: messages.subject,
        body: messages.bodyText,
        fromAddress: messages.fromAddress,
        sentAt: messages.sentAt,
        rn: sql<number>`row_number() over (partition by ${messages.threadId} order by ${messages.sentAt} desc)`.as(
          "rn",
        ),
      })
      .from(messages)
      .where(
        and(
          inArray(messages.threadId, buttonIds),
          inArray(messages.mailboxId, boxIds),
          eq(messages.direction, "in"),
          sql`${notDraftSql("messages")}`,
          sql`not ${sideEmailSql("messages")}`,
        ),
      )
      .as("ranked");
    const rows = await db()
      .select()
      .from(ranked)
      .where(lte(ranked.rn, 3))
      .orderBy(desc(ranked.sentAt));
    for (const r of rows) inbound.set(r.threadId, [...(inbound.get(r.threadId) ?? []), r]);

    // The owner's own numbers: never offered as the customer's. The signature, the alert
    // phone, and the end of their 10 newest sent emails (where a signature sits).
    const tails = await db()
      .select({ tail: sql<string | null>`right(${messages.bodyText}, 1500)` })
      .from(messages)
      .where(
        and(
          inArray(messages.mailboxId, boxIds),
          eq(messages.direction, "out"),
          sql`${notDraftSql("messages")}`,
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(10);
    for (const text of [profile?.signature, profile?.alertPhone, ...tails.map((t) => t.tail)])
      for (const n of findUsPhones(text ?? "", { anyBare: true })) ownerNumbers.add(n);
  }

  // Earlier jobs for the same customer (B14), one query for every card that can show a line.
  const repeatCards = cards.filter(
    (c) =>
      REPEAT_CATEGORIES.includes(c.category ?? "") &&
      !c.leadChannel &&
      c.customerAddress &&
      !isNoReplyAddress(c.customerAddress),
  );
  const earlier = new Map<string, (EarlierJob & { threadId: string })[]>();
  if (repeatCards.length) {
    const addresses = [...new Set(repeatCards.map((c) => c.customerAddress!.toLowerCase()))];
    const ownerWrote = sql<boolean>`exists (select 1 from messages o where o.thread_id = ${threads.id} and o.direction = 'out' and ${notDraftSql("o")} and not ${sideEmailSql("o")})`;
    const rows = await db()
      .selectDistinct({
        threadId: threads.id,
        address: sql<string>`${replyAddressSql("m")}`,
        outcome: threads.quoteOutcome,
        outcomeAt: threads.quoteOutcomeAt,
        amount: threads.quoteAmountCents,
        requestedAt: sql<
          string | Date | null
        >`coalesce(${threads.quoteRequestedAt}, (select min(f.sent_at) from messages f where f.thread_id = ${threads.id} and f.direction = 'in'))`,
        service: sql<string | null>`${threads.extracted}->>'service_requested'`,
        ownerWrote,
      })
      .from(threads)
      .innerJoin(sql`messages m`, sql`m.thread_id = ${threads.id} and m.direction = 'in'`)
      .where(
        and(
          inArray(threads.mailboxId, boxIds),
          sql`${threads.leadChannel} is null`,
          sql`(${threads.quoteRequestedAt} is not null or ${threads.category} = 'quote_request' or ${threads.quoteOutcome} is not null)`,
          sql`${replyAddressSql("m")} in (${sql.join(
            addresses.map((a) => sql`${a}`),
            sql`, `,
          )})`,
        ),
      );
    for (const r of rows) {
      const at = r.outcome === "won" && r.outcomeAt ? r.outcomeAt : r.requestedAt;
      if (!at) continue;
      const kind =
        r.outcome === "won" ? "won" : r.amount != null || r.ownerWrote ? "quoted" : "asked";
      earlier.set(r.address, [
        ...(earlier.get(r.address) ?? []),
        { threadId: r.threadId, kind, service: r.service, at: new Date(at as string | Date) },
      ]);
    }
  }

  const towns = profile?.serviceTowns ?? [];
  for (const c of cards) {
    const kind = channelKind(c.leadChannel);
    const msgs = inbound.get(c.threadId) ?? [];
    const newest = msgs[0];
    const site = kind === "site" && newest ? parseLeadSite(newest) : null;
    const phone = showsButtons(c)
      ? customerPhone({
          messages: msgs,
          ownerNumbers,
          machine: kind != null || isNoReplyAddress(newest?.fromAddress),
          subjectNamesCaller: kind === "phone" || kind === "phone_text",
          textAddress: kind === "phone_text" ? newest?.fromAddress : null,
        })
      : null;
    const firstName = kind ? firstNameOf(site?.customerName) : firstNameOf(c.customerName);
    const x = (c.extracted ?? {}) as { address?: unknown; owner_rule_hits?: unknown };
    const hits = Array.isArray(x.owner_rule_hits) ? (x.owner_rule_hits as string[]) : [];
    const outsideTown = outsideArea({
      category: c.category,
      address: typeof x.address === "string" ? x.address : null,
      towns,
    });
    const best = c.customerAddress
      ? bestEarlier(
          (earlier.get(c.customerAddress.toLowerCase()) ?? []).filter(
            (j) => j.threadId !== c.threadId,
          ),
        )
      : null;
    out.set(c.threadId, {
      phone,
      phoneShown: phone ? formatUsPhone(phone) : null,
      textBody: textPrefill({ firstName, businessName: opts.businessName }),
      firstName,
      channel: kind
        ? { kind, name: channelName(c.leadChannel) ?? "", openUrl: openSiteUrl(c.leadChannel) }
        : null,
      site,
      outsideTown,
      townClears: hits.length === 1 && hits[0] === "outside_area",
      repeat: best ? repeatLine(best, opts.now, opts.timeZone) : null,
    });
  }
  return out;
}

export { playbookApplies };
