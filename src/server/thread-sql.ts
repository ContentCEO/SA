import "server-only";
import { MAIL_LABELS } from "@/mailbox/connector";
import { sql, type SQL } from "drizzle-orm";
import { EMAIL_TO_TEXT_DOMAINS, PHONE_SERVICES } from "@/config/phone-services";
import { messages, threads } from "@/db/schema";
import { NO_REPLY_LOCAL_PATTERN, PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";

/**
 * SQL pieces about a thread, shared by the quote tracker, the scorecard and the summaries.
 * Content-free: times and flags only. (Price memory is not here and never will be.)
 */

/** A timestamp column or subquery result as a Date (postgres.js and PGlite differ). */
export const asDate = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null);

/**
 * The outer thread's id, always written "threads"."id". Drizzle writes a column that sits
 * directly in a selected field of a one-table query as a bare "id" — which, inside a
 * subquery on messages, would quietly mean the message's own id. Nested, it's qualified.
 */
const outerThreadId = () => sql`${threads.id}`;

/**
 * Check 47 P4: a label name (MAIL_LABELS, fixed constants) as SQL literals: a text literal for
 * jsonb `?`, and a one-element jsonb array for `@>`. Never built from anything but the constants.
 */
const labelText = (label: (typeof MAIL_LABELS)[keyof typeof MAIL_LABELS]) => `'${label}'`;
export const labelArray = (label: (typeof MAIL_LABELS)[keyof typeof MAIL_LABELS]) =>
  `'${JSON.stringify([label])}'::jsonb`;
export const labelSql = (label: (typeof MAIL_LABELS)[keyof typeof MAIL_LABELS]) =>
  sql.raw(labelText(label));

/**
 * An unsent Gmail draft, for a messages alias (`m`, `o`, …): DRAFT label and no SENT label —
 * the same rule as `isUnsentDraft` in sync.ts, so a row sync keeps is never one these checks
 * hide. Sync no longer stores drafts and a one-shot cleanup re-checks the old rows with Gmail,
 * but every "the owner wrote" check also says this so an unsent draft never counts as the
 * owner's answer. `label_ids` is NOT NULL, so the negation is never null.
 */
export const unsentDraftSql = (alias: string) =>
  sql.raw(
    `(${alias}.label_ids @> ${labelArray(MAIL_LABELS.draft)} and not (${alias}.label_ids @> ${labelArray(MAIL_LABELS.sent)}))`,
  );

/**
 * SQL twin of `customerReplyAddress` (reply-address-rules.ts), for a messages alias: the
 * stored usable Reply-To (a website form's customer), else the sender. Lowercased, trimmed.
 * The choice was made at sync (`pickReplyTo`), so this is a plain coalesce.
 */
export const replyAddressSql = (alias: string) =>
  sql.raw(`lower(trim(coalesce(${alias}.reply_to_header->>'address', ${alias}.from_address)))`);
/** SQL twin of `customerReplyName`: the Reply-To's own name when it redirects, else From's. */
export const replyNameSql = (alias: string) =>
  sql.raw(
    `(case when ${alias}.reply_to_header->>'address' is not null then ${alias}.reply_to_header->>'name' else ${alias}.from_name end)`,
  );
/** The same two on the messages table, in a query-builder select / where. */
export const messageReplyAddress = () =>
  sql<
    string | null
  >`lower(trim(coalesce(${messages.replyToHeader}->>'address', ${messages.fromAddress})))`;
export const messageReplyName = () =>
  sql<
    string | null
  >`(case when ${messages.replyToHeader}->>'address' is not null then ${messages.replyToHeader}->>'name' else ${messages.fromName} end)`;

/** The outer thread's newest inbound email's reply address / name: the screens' "customer". */
export const customerAddressSql = () =>
  sql<
    string | null
  >`(select ${replyAddressSql("cx_m")} from messages cx_m where cx_m.thread_id = ${outerThreadId()} and cx_m.direction = 'in' order by cx_m.sent_at desc limit 1)`;
export const customerNameSql = () =>
  sql<
    string | null
  >`(select ${replyNameSql("cx_m")} from messages cx_m where cx_m.thread_id = ${outerThreadId()} and cx_m.direction = 'in' order by cx_m.sent_at desc limit 1)`;

/** Not an unsent Gmail draft, for a messages alias. */
export const notDraftSql = (alias: string) => sql`not ${unsentDraftSql(alias)}`;

/** The same, as a condition on the messages table in a query-builder WHERE. */
export const unsentDraftMessage = () =>
  sql`(${messages.labelIds} @> ${sql.raw(labelArray(MAIL_LABELS.draft))} and not (${messages.labelIds} @> ${sql.raw(labelArray(MAIL_LABELS.sent))}))`;
export const notDraftMessage = () => sql`not ${unsentDraftMessage()}`;

/**
 * A forward ("Fwd:", "FW:") or a reply within one ("Re: Fwd:"), by its subject, matched
 * case-insensitively in Postgres (`~*`). The subject is only ever read inside WHERE clauses.
 */
export const FORWARD_SUBJECT_PATTERN = "^\\s*((re|aw)\\s*:\\s*)*fwd?\\s*:";

/** Webmail domains as a SQL list (constants of ours, checked to be plain host names). */
const WEBMAIL_SQL = sql.raw(
  [...PUBLIC_WEBMAIL_DOMAINS]
    .map((d) => {
      if (!/^[a-z0-9.-]+$/.test(d)) throw new Error("PUBLIC_WEBMAIL_DOMAINS: not a host name");
      return `'${d}'`;
    })
    .join(", "),
);

/** Every To and Cc address of an email (messages alias), one per row as `<as>(a)`. */
const recipientsOf = (alias: string, as: string) =>
  sql.raw(`jsonb_array_elements_text(${alias}.to_addresses || ${alias}.cc_addresses) as ${as}(a)`);

/** An address expression, normalized the way sync stores them (lowercased, trimmed). */
const norm = (expr: string) => sql.raw(`lower(trim(coalesce(${expr}, '')))`);

/**
 * `addr` (already normalized) is on email `alias` (an inbound one): its sender, its stored
 * Reply-To (a website form's customer), or To / Cc.
 */
const involvedSql = (alias: string, addr: SQL) =>
  sql`(${norm(`${alias}.from_address`)} = ${addr} or ${norm(`${alias}.reply_to_header->>'address'`)} = ${addr} or exists (select 1 from ${recipientsOf(alias, "sx_x")} where ${norm("sx_x.a")} = ${addr}))`;

/** The domain of a normalized address expression (after the last "@"). */
const domainOf = (addr: SQL) => sql`regexp_replace(${addr}, '^.*@', '')`;

/**
 * The owner's business domain for an email (messages alias): its mailbox's domain, or null on
 * public webmail (shared with strangers, so "same domain" says nothing there).
 */
const businessDomainSql = (alias: string) =>
  sql`(select sx_d.d from (select ${domainOf(norm("sx_mb.email"))} from mailboxes sx_mb where sx_mb.id = ${sql.raw(alias)}.mailbox_id) as sx_d(d) where sx_d.d <> '' and sx_d.d not in (${WEBMAIL_SQL}))`;

/**
 * The SHAPE of an owner email that may be a side conversation (alias `o`): it goes to someone,
 * and either (1) its subject is a forward the owner started ("Fwd:", or a reply within one)
 * on a thread whose lead did NOT itself arrive as a forward — when an office manager, a
 * property manager or a friend forwarded the lead, the owner's "Re: Fwd:" to the customer is
 * the answer, though the customer may never have been on a header — or (2) every recipient is
 * on the owner's own business domain (crew@shop.com: a "Re:" with the To changed to the crew).
 * A public webmail domain is shared with strangers, so (2) never applies on gmail.com and the
 * like. Whether it IS a side email also depends on who the recipients are (`sideOutSql`).
 */
const sideShapeSql = (o: string) => {
  const a = sql.raw(o);
  const own = businessDomainSql(o);
  return sql`(jsonb_array_length(${a}.to_addresses || ${a}.cc_addresses) > 0 and (
    (coalesce(${a}.subject, '') ~* ${FORWARD_SUBJECT_PATTERN}
      and not coalesce((select coalesce(sx_fi.subject, '') ~* ${FORWARD_SUBJECT_PATTERN} from messages sx_fi where sx_fi.thread_id = ${a}.thread_id and sx_fi.direction = 'in' order by sx_fi.sent_at asc, sx_fi.id asc limit 1), false))
    or (${own} is not null and not exists (select 1 from ${recipientsOf(o, "sx_rd")} where ${domainOf(norm("sx_rd.a"))} is distinct from ${own}))
  ))`;
};

/**
 * An inbound email (alias `i`) that is a side conversation: its sender is someone the owner
 * passed the lead to — a To / Cc of an owner email of side shape, or of any owner email when
 * the sender is on the owner's own business domain ("Dana, meet Mike, my estimator", Mike
 * in Cc) — who had never been on the thread's inbound mail (sender, To or Cc) before that
 * email. The crew's reply, however it's worded. Not recursive: the sender is checked against
 * ALL earlier inbound. A customer the owner first reached at a contact form's Reply-To is
 * never one: the stored Reply-To puts them on the customer's side (`involvedSql`).
 */
const sideInSql = (i: string) => {
  const a = sql.raw(i);
  const from = norm(`${i}.from_address`);
  const own = businessDomainSql(i);
  return sql`(${a}.direction = 'in' and exists (select 1 from messages sx_f where sx_f.thread_id = ${a}.thread_id and sx_f.direction = 'out' and ${notDraftSql("sx_f")} and sx_f.sent_at < ${a}.sent_at
    and (${sideShapeSql("sx_f")} or coalesce(${domainOf(from)} = ${own}, false))
    and exists (select 1 from ${recipientsOf("sx_f", "sx_y")} where ${norm("sx_y.a")} = ${from})
    and not exists (select 1 from messages sx_p where sx_p.thread_id = sx_f.thread_id and sx_p.direction = 'in' and sx_p.sent_at < sx_f.sent_at and ${involvedSql("sx_p", from)})))`;
};

/**
 * An owner email (alias `o`) that is a side conversation: side shape (`sideShapeSql`), and
 * none of its recipients is on the customer's side — nobody it went to had been on the
 * thread's inbound mail before it (sender, To or Cc), other than in a side email of their
 * own (`sideInSql`: the crew's reply). So a forward with the customer in To or Cc answers
 * the customer, and the owner's later notes to the crew stay on the side.
 */
const sideOutSql = (o: string) => {
  const a = sql.raw(o);
  return sql`(${a}.direction = 'out' and ${sideShapeSql(o)} and not exists (select 1 from ${recipientsOf(o, "sx_r")} where exists (select 1 from messages sx_k where sx_k.thread_id = ${a}.thread_id and sx_k.direction = 'in' and sx_k.sent_at < ${a}.sent_at and ${involvedSql("sx_k", norm("sx_r.a"))} and not ${sideInSql("sx_k")})))`;
};

/**
 * A side conversation on the thread, for a messages alias: the owner passing the lead to the
 * crew or a supplier (Gmail keeps a forward in the same conversation), or their reply. It
 * answers nobody and leaves nobody waiting. Decided by who the owner wrote to, never by a
 * single "customer" address: whoever was on the thread's inbound mail (sender, To or Cc) is
 * the customer's side, a stored Reply-To included (so an owner "Fwd:" to a form lead's own
 * address answers them). See `sideOutSql` / `sideInSql`. Not a strict "went to the customer"
 * rule, on purpose: rows stored before Reply-To was read (or outside the backfill window) have
 * none stored, and a lead forwarded by a property manager or a friend has the customer on no
 * header at all. So a plain "Re:" the owner sends only to an outside address still answers
 * the lead. Self-contained (it reads the alias's own thread), so it
 * works on any messages alias, with or without the threads table in the query.
 */
export const sideEmailSql = (alias: string) => sql`(${sideInSql(alias)} or ${sideOutSql(alias)})`;

/**
 * When the customer / the owner last wrote on the thread (correlated subqueries). Neither an
 * unsent Gmail draft nor a side conversation (a forward to the crew, `sideEmailSql`) counts;
 * the owner's "I called them" (`threads.handled_offline_at`, round 2 FW E11) does:
 * one answer for "the owner wrote" everywhere — leads at risk, the scorecard, Quotes'
 * stages, the digest's waits, no-answer guesses and follow-ups.
 */
export const lastInSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in' and not m.auto_reply and not ${sideEmailSql("m")})`;
export const lastOutSql = () =>
  sql<
    string | Date | null
  >`greatest((select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'out' and ${notDraftSql("m")} and not ${sideEmailSql("m")}), ${threads.handledOfflineAt})`;

/**
 * Check 21 P1: the customer's newest email that needs an answer — not an automatic reply, not
 * a bare acknowledgement ("Thanks, we'll look it over and get back to you", `ack_only`).
 */
export const lastAnswerInSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in' and not m.auto_reply and not m.ack_only and not ${sideEmailSql("m")})`;

/**
 * Check 21 P1: the ball is in the customer's court — the owner wrote, and everything the
 * customer sent since was an acknowledgement or an automatic reply. Never NULL.
 */
export const ballInTheirCourtSql = () =>
  sql`(${lastOutSql()} is not null and ${lastOutSql()} > coalesce(${lastAnswerInSql()}, '-infinity'::timestamptz))`;

/**
 * Check 21 P1: when the quiet started — the owner's last email, or the customer's later
 * acknowledgement ("we'll look it over" on Tuesday: the wait counts from Tuesday).
 */
export const quietSinceSql = () =>
  sql<string | Date | null>`greatest(${lastOutSql()}, ${lastInSql()})`;

/**
 * Round 2 (FW E11): the owner said they answered by phone ("I called them") after the
 * customer's newest email. Never NULL. Follow-ups and auto drafts skip these: the call was
 * the answer, so nothing is drafted until the customer writes again.
 */
export const answeredByPhoneSql = () =>
  sql`(${threads.handledOfflineAt} is not null and ${threads.handledOfflineAt} >= coalesce(${lastInSql()}, '-infinity'::timestamptz))`;

/**
 * Since when the customer has been waiting (plan M8 A14): their first message after the
 * owner's last one. Null when the owner wrote last (or nobody wrote in) — nothing to wait on.
 * One wait per thread: it moves on each time the owner answers, so an alert re-arms.
 */
export const waitingSinceSql = () =>
  sql<
    string | Date | null
  >`(select min(w.sent_at) from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and not w.auto_reply and not ${sideEmailSql("w")} and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz))`;

/** The sender of that first waiting email (for WHERE clauses only: A2). */
export const waitingSenderSql = () =>
  sql`(select w.from_address from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and not w.auto_reply and not ${sideEmailSql("w")} and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz) order by w.sent_at asc, w.id asc limit 1)`;

/** Where a reply to that first waiting email goes (`replyAddressSql`; WHERE clauses only). */
export const waitingReplySql = () =>
  sql`(select ${replyAddressSql("w")} from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and not w.auto_reply and not ${sideEmailSql("w")} and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz) order by w.sent_at asc, w.id asc limit 1)`;

/**
 * SQL twin of `isQuoteThread` (quote-rules.ts) — keep the two in step. A quote thread: sorted
 * as a quote request, OR carrying the sticky `quote_requested_at` mark (Check 11 P1: the
 * customer's "Could you do Thursday?" re-sorts the thread as scheduling, and the quote must
 * stay on Quotes), OR it has ever had an outcome (a cleared guess or an owner's reopen keeps
 * its source), whatever its category now — unless the owner said "Not a quote" (Check 11 P8)
 * and hasn't marked an outcome since. A thread now sorted as noise, or holding an email
 * that tried to instruct us (`extracted.injection`), is left out unless the owner marked it
 * (`quote_outcome_source = 'owner'`, or an outcome from before the column, which is theirs).
 */
export const quoteThreadSql = () =>
  sql`(((${threads.quoteOutcomeSource} = 'owner' or (${threads.quoteOutcome} is not null and ${threads.quoteOutcomeSource} is null))
    or (${threads.category} is distinct from 'noise'
      and coalesce(${threads.extracted}->>'injection', '') <> 'true'
      and (${threads.category} = 'quote_request' or ${threads.quoteRequestedAt} is not null or ${threads.quoteOutcome} is not null or ${threads.quoteOutcomeSource} is not null)))
    and ${quoteNotDismissedSql()})`;

/**
 * Check 11 P8: not "Not a quote", or the owner marked an outcome after saying so. Never NULL
 * (callers negate it).
 */
export const quoteNotDismissedSql = () =>
  sql`(${threads.quoteDismissedAt} is null or coalesce(${threads.quoteOutcomeSource} = 'owner' and ${threads.quoteOutcomeAt} > ${threads.quoteDismissedAt}, false))`;

/**
 * A quote request, even one later re-sorted (plan M8 A11). Since Check 11 P1 this is the same
 * rule as `quoteThreadSql` (which now holds the sticky mark), so Quotes and Activity count the
 * same threads.
 */
export const quoteRequestSql = () => quoteThreadSql();

/**
 * When a quote request was asked for, for the scorecard and the monthly summary: the sticky
 * `quote_requested_at` from classification (the customer's first email since the owner last
 * wrote, so a new job asked for on an old conversation dates from the new request), else —
 * threads sorted before the mark existed — the thread's first customer email.
 */
export const requestAtSql = () =>
  sql<
    string | Date | null
  >`coalesce(${threads.quoteRequestedAt}, (select min(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in'))`;

/**
 * Who asked: the sender of the first customer email at or after the request time. For WHERE
 * clauses and comparisons only — never selected (A2).
 */
export const requestSenderSql = () =>
  sql`(select m.from_address from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in' and m.sent_at >= coalesce(${threads.quoteRequestedAt}, '-infinity'::timestamptz) order by m.sent_at asc, m.id asc limit 1)`;

/** Where a reply to the requester goes (`replyAddressSql`; WHERE clauses only). */
export const requestReplySql = () =>
  sql`(select ${replyAddressSql("m")} from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in' and m.sent_at >= coalesce(${threads.quoteRequestedAt}, '-infinity'::timestamptz) order by m.sent_at asc, m.id asc limit 1)`;

/**
 * Check 12 P4: who an address is, for "the same sender" — its domain ("@supply.com"), or the
 * whole address on public webmail (one gmail.com supplier says nothing about the rest).
 */
const senderKeySql = (addr: SQL) =>
  sql`(case when ${domainOf(addr)} in (${WEBMAIL_SQL}) then ${addr} else '@' || ${domainOf(addr)} end)`;

/** The outer thread's newest inbound sender, normalized (WHERE clauses only). */
const newestSenderSql = () =>
  sql`(select ${norm("bs_m.from_address")} from messages bs_m where bs_m.thread_id = ${outerThreadId()} and bs_m.direction = 'in' order by bs_m.sent_at desc limit 1)`;

/**
 * Another thread in the same workspace whose inbound mail comes from the same sender as the
 * outer thread's newest email and matches `cond` (on alias `bs_t`). Content-free: addresses
 * are only compared inside the database, never selected.
 */
const sameSenderThreadSql = (cond: SQL, byDomain: boolean) =>
  sql`(${newestSenderSql()} like '%@%' and exists (select 1 from threads bs_t join messages bs_i on bs_i.thread_id = bs_t.id
    where bs_t.mailbox_id in (select bs_x.id from mailboxes bs_x where bs_x.workspace_id = (select bs_w.workspace_id from mailboxes bs_w where bs_w.id = ${threads.mailboxId}))
      and bs_t.id <> ${outerThreadId()} and bs_i.direction = 'in' and ${cond}
      and ${
        byDomain
          ? sql`${senderKeySql(norm("bs_i.from_address"))} = ${senderKeySql(newestSenderSql())}`
          : sql`${norm("bs_i.from_address")} = ${newestSenderSql()}`
      }))`;

/** Check 12 P4: the sender's business (domain) has another thread sorted supplier_vendor. */
export const senderHasSupplierThreadSql = () =>
  sameSenderThreadSql(sql`bs_t.category = 'supplier_vendor'`, true);
/**
 * Check 12 P4: the owner tapped "Not owed to me" on another thread from this exact address.
 * Not the whole domain (safe default): a property manager's office or a company with several
 * contacts shares one, and one hidden duplicate must not hide every colleague's invoice.
 */
export const senderMarkedNotOwedSql = () =>
  sameSenderThreadSql(sql`bs_t.invoice_paid_source = 'not_owed'`, false);

/**
 * SQL twin of `billOwedByOwner` (money-rules.ts) — keep the two in step: a bill the business
 * owes. Never NULL, so `not (...)` is safe.
 */
export const billOwedByOwnerSql = () =>
  sql`coalesce((${threads.extracted}->>'bill_direction') = 'owed_by_business'
    or ((${threads.extracted}->>'bill_direction') is distinct from 'owed_to_business'
      and ${threads.invoicePaidSource} is distinct from 'owner'
      and (${senderHasSupplierThreadSql()} or ${senderMarkedNotOwedSql()})), false)`;

/**
 * SQL twin of `isNoReplyAddress` for an address expression: the local part before the last
 * "@" matches the shared no-reply pattern. Used only inside WHERE clauses, so the address
 * itself never leaves the database.
 */
export const noReplySql = (address: SQL) =>
  sql`(position('@' in coalesce(${address}, '')) > 1 and regexp_replace(lower(trim(${address})), '@[^@]*$', '') ~ ${NO_REPLY_LOCAL_PATTERN})`;

/**
 * SQL twin of `channelOf(from)?.kind` being `phone` or `phone_text` (leads package): the sender
 * is a voicemail-by-email service on `PHONE_SERVICES` (exact address) or an email-to-text
 * gateway on `EMAIL_TO_TEXT_DOMAINS` (the domain or a subdomain). Pass the From address, not the
 * Reply-To, as `channelOf` does. WHERE clauses only, so the address never leaves the database.
 */
export const phoneMessageSenderSql = (fromAddress: SQL) => {
  const a = sql`lower(trim(coalesce(${fromAddress}, '')))`;
  const host = sql`regexp_replace(${a}, '^.*@', '')`;
  const senders = PHONE_SERVICES.flatMap((svc) => svc.senders).map((x) => sql`${x}`);
  const gateways = EMAIL_TO_TEXT_DOMAINS.map(
    (d) => sql`(${host} = ${d} or ${host} like ${`%.${d}`})`,
  );
  return sql`(position('@' in ${a}) > 1 and (${a} in (${sql.join(senders, sql`, `)}) or ${sql.join(gateways, sql` or `)}))`;
};

/**
 * Check 36 P3: the owner's newest email on the outer thread (not an unsent draft, not a side
 * email): its text, for the "service call" rule only (an amount check in code). Never logged.
 */
export const ownerNewestBodySql = () =>
  sql<
    string | null
  >`(select ow_m.body_text from messages ow_m where ow_m.thread_id = ${outerThreadId()} and ow_m.direction = 'out' and ${notDraftSql("ow_m")} and not ${sideEmailSql("ow_m")} order by ow_m.sent_at desc limit 1)`;

/**
 * Check 36 P3: SQL twin (a superset) of `isServiceCall`: an emergency-marked thread whose
 * owner's newest email has no dollar figure at all. The code check (`isServiceCall`, on the
 * owner's own words without the quoted part) is the real gate. Never NULL.
 */
export const serviceCallSql = () =>
  sql`(coalesce(${threads.extracted}->>'emergency', '') = 'true' and coalesce(${ownerNewestBodySql()}, '') !~ '\\$\\s?[0-9]')`;
