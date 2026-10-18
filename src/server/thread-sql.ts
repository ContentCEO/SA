import "server-only";
import { eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
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
 * An unsent Gmail draft, for a messages alias (`m`, `o`, …): DRAFT label and no SENT label —
 * the same rule as `isUnsentDraft` in sync.ts, so a row sync keeps is never one these checks
 * hide. Sync no longer stores drafts and a one-shot cleanup re-checks the old rows with Gmail,
 * but every "the owner wrote" check also says this so an unsent draft never counts as the
 * owner's answer. `label_ids` is NOT NULL, so the negation is never null.
 */
export const unsentDraftSql = (alias: string) =>
  sql.raw(
    `(${alias}.label_ids @> '["DRAFT"]'::jsonb and not (${alias}.label_ids @> '["SENT"]'::jsonb))`,
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
  sql`(${messages.labelIds} @> '["DRAFT"]'::jsonb and not (${messages.labelIds} @> '["SENT"]'::jsonb))`;
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
  >`(select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in' and not ${sideEmailSql("m")})`;
export const lastOutSql = () =>
  sql<
    string | Date | null
  >`greatest((select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'out' and ${notDraftSql("m")} and not ${sideEmailSql("m")}), ${threads.handledOfflineAt})`;

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
  >`(select min(w.sent_at) from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and not ${sideEmailSql("w")} and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz))`;

/** The sender of that first waiting email (for WHERE clauses only: A2). */
export const waitingSenderSql = () =>
  sql`(select w.from_address from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and not ${sideEmailSql("w")} and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz) order by w.sent_at asc, w.id asc limit 1)`;

/** Where a reply to that first waiting email goes (`replyAddressSql`; WHERE clauses only). */
export const waitingReplySql = () =>
  sql`(select ${replyAddressSql("w")} from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and not ${sideEmailSql("w")} and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz) order by w.sent_at asc, w.id asc limit 1)`;

/**
 * SQL twin of `isQuoteThread`: sorted as a quote request, or has ever had an outcome
 * (a cleared guess or an owner's reopen keeps its source), whatever its category now.
 */
export const quoteThreadSql = () =>
  or(
    eq(threads.category, "quote_request"),
    isNotNull(threads.quoteOutcome),
    isNotNull(threads.quoteOutcomeSource),
  );

/**
 * A quote request, even one later re-sorted (plan M8 A11): the sticky `quote_requested_at`
 * mark from classification, or the current quote-thread rule (older threads have no mark).
 */
export const quoteRequestSql = () => or(isNotNull(threads.quoteRequestedAt), quoteThreadSql());

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
 * SQL twin of `isNoReplyAddress` for an address expression: the local part before the last
 * "@" matches the shared no-reply pattern. Used only inside WHERE clauses, so the address
 * itself never leaves the database.
 */
export const noReplySql = (address: SQL) =>
  sql`(position('@' in coalesce(${address}, '')) > 1 and regexp_replace(lower(trim(${address})), '@[^@]*$', '') ~ ${NO_REPLY_LOCAL_PATTERN})`;

/**
 * Check 22 P10 + 41 P6: SQL twin of `isCrewAddress` (sender-rules.ts) for an address
 * expression in workspace `workspaceId`: on the owner's crew list
 * (`business_profile.crew_addresses`), one of the workspace's own Gmail addresses, or on a
 * connected mailbox's business domain (never public webmail). WHERE clauses / aggregates only,
 * so the address never leaves the database.
 */
export const crewSql = (workspaceId: string | SQL, address: SQL) => {
  const a = sql`lower(trim(coalesce(${address}, '')))`;
  const w = typeof workspaceId === "string" ? sql`${workspaceId}::uuid` : workspaceId;
  return sql`(position('@' in ${a}) > 1 and (
    exists (select 1 from business_profile cw_bp where cw_bp.workspace_id = ${w} and ${a} = any(cw_bp.crew_addresses))
    or exists (select 1 from mailboxes cw_mb where cw_mb.workspace_id = ${w} and (lower(trim(cw_mb.email)) = ${a}
      or (${domainOf(norm("cw_mb.email"))} not in (${WEBMAIL_SQL}) and ${domainOf(norm("cw_mb.email"))} = ${domainOf(a)})))
  ))`;
};

/**
 * Check 22 P10 + 41 P6: the outer thread is a conversation with the owner's own people only —
 * it has inbound mail and every inbound email's reply address is crew (`crewSql`). A customer
 * thread where the crew replied to a forward still has the customer on it, so it never is.
 */
export const crewThreadSql = (workspaceId: string | SQL) =>
  sql`(exists (select 1 from messages cw_i where cw_i.thread_id = ${outerThreadId()} and cw_i.direction = 'in') and not exists (select 1 from messages cw_o where cw_o.thread_id = ${outerThreadId()} and cw_o.direction = 'in' and not ${crewSql(workspaceId, replyAddressSql("cw_o"))}))`;

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
