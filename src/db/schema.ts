/**
 * Drizzle schema. Tables are added milestone by milestone; migrations are
 * generated into /drizzle with `pnpm db:generate` and checked in.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { GrowthService } from "../config/growth";
import type { Licenses } from "../config/licenses";
import { TRADES, type Trade } from "../config/trades";
import type { LostReason } from "../server/quote-rules";
import type { ReplyToHeader } from "../server/reply-address-rules";

export type TimeZoneSource = "default" | "browser" | "owner";

export const tradeEnum = pgEnum("trade", TRADES);

export const workspaceStatusEnum = pgEnum("workspace_status", [
  "invited",
  "evaluating",
  "evaluation_expired",
  "setup_paid",
  "active",
  "past_due",
  "canceled",
  "paused",
]);

export const planEnum = pgEnum("plan", ["solo", "crew", "company"]);

export const mailboxProviderEnum = pgEnum("mailbox_provider", ["gmail"]);

export const mailboxStatusEnum = pgEnum("mailbox_status", ["active", "reconnect_needed", "paused"]);

/** Why a mailbox is `paused` (plan #47 offer A): more inboxes than the plan includes. */
export const MAILBOX_PAUSED_REASONS = ["over_plan"] as const;
export type MailboxPausedReason = (typeof MAILBOX_PAUSED_REASONS)[number];

export const actorEnum = pgEnum("actor", ["squared_away", "owner"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: createdAt(),
  /**
   * When this person last ticked "I agree to the Terms of Service and the Privacy Policy", and
   * which version (TERMS_VERSION in src/config/legal.ts: the terms' "Last updated" date). Every
   * signed-in screen asks again when the version moves on. Goes with the row (Delete my account).
   */
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  termsVersion: text("terms_version"),
});

/** Sign-in is invite-only. Davi adds rows here (script now, /admin in Milestone 6). */
export const invites = pgTable("invites", {
  email: text("email").primaryKey(),
  trade: tradeEnum("trade"),
  note: text("note"),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  /**
   * Round 2 (FW A4): Davi ticked "Added as a Google test user" for this address. Only matters
   * while the Google app is in Testing (an owner who isn't a test user can't connect Gmail).
   */
  testUserAddedAt: timestamp("test_user_added_at", { withTimezone: true }),
  /**
   * Plan #47 (behind FEATURE_REFERRALS): the workspace whose referral link this owner came
   * from. Used up (set back to null) at the first sign-in, when it moves onto their workspace.
   */
  referredByWorkspaceId: uuid("referred_by_workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
  }),
  /**
   * Squared Away Growth (2026-10-16): Davi's "Invite to Growth" for someone with no account yet.
   * While set, their next sign-in makes the new account a Growth client with these services and
   * this start date, then clears all three. Never starts an app trial (that still begins only
   * when Gmail is connected).
   */
  growthInvitedAt: timestamp("growth_invited_at", { withTimezone: true }),
  growthServices: text("growth_services").array().$type<GrowthService[]>(),
  growthStartedOn: date("growth_started_on", { mode: "string" }),
});

/** People who asked for access on the public site. Davi invites from /admin. */
export const waitlist = pgTable("waitlist", {
  email: text("email").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  trade: tradeEnum("trade"),
  teamSize: text("team_size"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  /** Plan #47: the referral code from the link they came from (format-checked; flag on only). */
  referralCode: text("referral_code"),
  /** Where the sign-up came from (first touch): utm_* tags and the referring site's host only. */
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  referrerHost: text("referrer_host"),
  /** When the "You're on the list" email went to them (one per address, ever). */
  confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessName: text("business_name"),
    trade: tradeEnum("trade"),
    /**
     * Round 2 (TW A4): up to two more trades the shop does besides `trade` ("plumbing and
     * heating"). Values from TRADES, checked in code (`cleanExtraTrades`); never the main one.
     */
    extraTrades: text("extra_trades").array().$type<Trade[]>().notNull().default([]),
    status: workspaceStatusEnum("status").notNull().default("invited"),
    /**
     * Check 17 P1: where a paused account stood when Davi paused it (its effective status then),
     * kept up to date by Stripe webhooks while it's paused, and where Resume takes it back to.
     * Null when not paused (or paused before this column existed: see `resumeTarget`).
     */
    pausedFrom: workspaceStatusEnum("paused_from"),
    evaluationStartedAt: timestamp("evaluation_started_at", { withTimezone: true }),
    evaluationEndsAt: timestamp("evaluation_ends_at", { withTimezone: true }),
    setupPaidAt: timestamp("setup_paid_at", { withTimezone: true }),
    /**
     * How setup was paid — the send gate needs one of these, not just a status:
     * "stripe" = Stripe's signed webhook confirmed a real payment; "house" = Davi's own
     * admin account (testing). Nothing else turns sending on.
     */
    setupPaidVia: text("setup_paid_via").$type<"stripe" | "house">(),
    setupCallCompletedAt: timestamp("setup_call_completed_at", { withTimezone: true }),
    plan: planEnum("plan"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: createdAt(),
    /** Plan #47: this workspace's own referral code (random, made the first time it's shown). */
    referralCode: text("referral_code"),
    /** Plan #47: who referred this workspace. Set once, at the first sign-in; never overwritten. */
    referredByWorkspaceId: uuid("referred_by_workspace_id").references(
      (): AnyPgColumn => workspaces.id,
      { onDelete: "set null" },
    ),
    /**
     * Plan #47 offer A: the plan given free during a running referral month, and when that month
     * ends. Set when a reward goes `running`, cleared when it is `done`. Features read the higher
     * of this and `plan` only while `free_plan_until` is in the future (`effectivePlan`), so they
     * drop at the end even if no job runs.
     */
    freePlan: planEnum("free_plan"),
    freePlanUntil: timestamp("free_plan_until", { withTimezone: true }),
    /**
     * When Stripe will end the subscription (`cancel_at`, or the period end when it is set to
     * cancel then), from a fresh read. Only the status lines read it. Null = renews.
     */
    stripeCancelAt: timestamp("stripe_cancel_at", { withTimezone: true }),
    /**
     * Trial emails (Davi, 2026-10-16): the owner tapped "Stop these emails" (or switched them
     * off in Settings). Null = they go. Only the trial emails read it; the morning email has
     * its own switch.
     */
    trialEmailsStoppedAt: timestamp("trial_emails_stopped_at", { withTimezone: true }),
    /**
     * Which trial emails already went ("day2", "day3", "after"), so each goes once ever. Written
     * only after Resend took it. Day 1 is the "first drafts are ready" email (its own marker).
     */
    trialEmailsSent: text("trial_emails_sent").array().notNull().default([]),
  },
  (t) => [
    // One owner per workspace for the MVP.
    uniqueIndex("workspaces_owner_uq").on(t.ownerUserId),
    uniqueIndex("workspaces_referral_code_uq").on(t.referralCode),
  ],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: mailboxProviderEnum("provider").notNull().default("gmail"),
    email: text("email").notNull(),
    /** AES-256-GCM, see src/lib/crypto.ts. Never log, never send to the client. */
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    scopes: text("scopes").notNull(),
    historyId: text("history_id"),
    watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
    status: mailboxStatusEnum("status").notNull().default("active"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the 30-day backfill finishes; incremental sync only runs after this. */
    backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** When Google access was lost (status → reconnect_needed); cleared on reconnect. */
    accessLostAt: timestamp("access_lost_at", { withTimezone: true }),
    /** "Reconnect Gmail" emails sent for the current loss (max 2); reset on reconnect. */
    accessAlertsSent: integer("access_alerts_sent").notNull().default(0),
    /** Last sync problem as a short code (access_lost / rate_limited / sync_failed) — never text. */
    lastSyncErrorCode: text("last_sync_error_code"),
    lastSyncErrorAt: timestamp("last_sync_error_at", { withTimezone: true }),
    /**
     * Unused since the referral merge (2026-10-17). Plan #47's branch paused over-plan inboxes
     * with `status = 'paused'` + this reason; the decisions package's `plan_paused_at` (below)
     * does the same job everywhere, so the referral code now uses that. The column stays only
     * because its migration (0044) is kept byte-identical; nothing reads or writes it.
     */
    pausedReason: text("paused_reason").$type<MailboxPausedReason>(),
    /**
     * Davi, 2026-10-16: the plan covers fewer Gmail addresses than are connected, so this one is
     * paused — nothing is read, sorted, drafted, sent, alerted or learned from it; its data is
     * kept. Null = on. Set and cleared only by `fitMailboxesToPlan` / `swapPlanMailbox`
     * (src/server/mailbox-plan.ts). A column, not a `status` value, so lost Google access and
     * a plan pause are told apart (a paused address can need reconnecting too).
     */
    planPausedAt: timestamp("plan_paused_at", { withTimezone: true }),
    /**
     * Check 25 P1: Gmail itself said "slow down until …". Every Gmail call for this inbox stops
     * before any fetch until then, so all its jobs wait together.
     */
    gmailCoolUntil: timestamp("gmail_cool_until", { withTimezone: true }),
    /**
     * Check 25 P3: Gmail's history expired, so the gap is re-read from this time, one page per
     * step. Null = no re-read under way. `resync_page_token` is where the next page starts.
     */
    resyncSince: timestamp("resync_since", { withTimezone: true }),
    resyncPageToken: text("resync_page_token"),
    /**
     * Check 25 P5: a first read that stopped part-way (a run cap, a failure) resumes here —
     * the next page's token, pages stored so far, and the fixed window start (`after:`).
     * Cleared when the read finishes and on a reconnect (which starts a fresh read).
     */
    backfillPageToken: text("backfill_page_token"),
    backfillPagesDone: integer("backfill_pages_done").notNull().default(0),
    backfillSince: timestamp("backfill_since", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_workspace_email_uq").on(t.workspaceId, sql`lower(${t.email})`),
    index("mailboxes_workspace_idx").on(t.workspaceId),
    // Check 25 P7: one Gmail in one account (checked in saveConnectedMailbox). Not unique yet:
    // production may already hold a duplicate; check before making it unique.
    index("mailboxes_email_lower_idx").on(sql`lower(${t.email})`),
  ],
);

export const directionEnum = pgEnum("direction", ["in", "out"]);

export const QUOTE_OUTCOME_SOURCES = ["owner", "auto"] as const;
export type QuoteOutcomeSource = (typeof QUOTE_OUTCOME_SOURCES)[number];
/** `not_owed`: the owner hid the row ("Not owed to me"); it counts as neither owed nor paid. */
export const INVOICE_PAID_SOURCES = ["owner", "auto", "not_owed"] as const;
export type InvoicePaidSource = (typeof INVOICE_PAID_SOURCES)[number];

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    subject: text("subject"),
    /** Email addresses on the thread, excluding the mailbox itself. */
    participants: jsonb("participants").$type<string[]>().notNull().default([]),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Any message on the thread carries Gmail's INBOX label. Bodies are only kept for these. */
    inInbox: boolean("in_inbox").notNull().default(false),
    // Filled by classification (Milestone 3) and follow-ups (Milestone 7).
    category: text("category"),
    priority: text("priority"),
    needsOwner: boolean("needs_owner").notNull().default(false),
    needsOwnerReason: text("needs_owner_reason"),
    /** The owner said "This one needs me". Classification never clears it. */
    needsOwnerManual: boolean("needs_owner_manual").notNull().default(false),
    /**
     * Check 10 P1: when needs_owner last turned true (the email that raised it, or the owner's
     * own mark). Any owner answer after this (a Gmail reply, an app send, "I called them") lets
     * go of the flag. Null on older rows: reads fall back to classified_at.
     */
    needsOwnerSince: timestamp("needs_owner_since", { withTimezone: true }),
    /** Plan #6: hidden from the queue until then; comes back on top. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /** One-sentence summary from classification. Kept after bodies are purged. */
    summary: text("summary"),
    /** Structured facts pulled from the latest inbound message (service, address, dates, amounts). */
    extracted: jsonb("extracted").$type<Record<string, unknown>>(),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    awaitingReplySince: timestamp("awaiting_reply_since", { withTimezone: true }),
    followupCount: integer("followup_count").notNull().default(0),
    /** Quote tracker: the owner's "Won" / "Lost" (null = still open). */
    quoteOutcome: text("quote_outcome"),
    quoteOutcomeAt: timestamp("quote_outcome_at", { withTimezone: true }),
    /**
     * What the job was quoted at, in cents: taken from the owner's own reply (the price in it, `readOwnerAmount`,
     * captured before bodies are purged) or typed by the owner. Kept after the purge.
     */
    quoteAmountCents: integer("quote_amount_cents"),
    /**
     * Check 11 P2: how the amount was read from the owner's reply — 'total' (a figure marked as
     * the price, or the only one) or 'picked' (the last of several: the card says "Check
     * amount", and it stays out of price memory). Null for a typed amount or older rows.
     */
    quoteAmountNote: text("quote_amount_note").$type<"total" | "picked">(),
    /**
     * Check 11 P3: where the amount came from — 'reply' (read from the owner's email, so a
     * corrected price replaces it while the quote is open) or 'owner' (typed on Quotes, never
     * replaced). Null on rows from before the column.
     */
    quoteAmountFrom: text("quote_amount_from").$type<"reply" | "owner">(),
    /**
     * Check 11 P3: when the price went out — the sent time of the owner email the amount came
     * from, or when the owner typed it. Quotes' "Priced" total counts by this.
     */
    quoteAmountAt: timestamp("quote_amount_at", { withTimezone: true }),
    /**
     * Who set quote_outcome: the owner ("owner") or our guess ("auto"). The owner always wins.
     * Rows set before this column existed (outcome set, source null) are the owner's.
     */
    quoteOutcomeSource: text("quote_outcome_source").$type<QuoteOutcomeSource>(),
    /** Plan #27: when this invoice was marked paid (or hidden as "Not owed to me"). Null = owed. */
    invoicePaidAt: timestamp("invoice_paid_at", { withTimezone: true }),
    invoicePaidSource: text("invoice_paid_source").$type<InvoicePaidSource>(),
    /**
     * First time this thread was classified as a complaint. Sticky: never cleared, so a later
     * "looks great" can't make an unhappy customer look like a review prospect.
     */
    complainedAt: timestamp("complained_at", { withTimezone: true }),
    /**
     * Round 2 (FW E11): the owner tapped "I called them": answered by phone at this time. Until
     * the customer writes again it counts as the owner's answer: no auto draft, no nudge, off
     * "Needs you", and the scorecard counts it. A later customer email starts things over.
     */
    handledOfflineAt: timestamp("handled_offline_at", { withTimezone: true }),
    /**
     * Check 11 P8: the owner said "Not a quote". Off Quotes (and Customers' open quotes) until
     * "Put back", or until the owner marks an outcome after this time.
     */
    quoteDismissedAt: timestamp("quote_dismissed_at", { withTimezone: true }),
    /**
     * Check 21 P2: the customer asked us to wait ("after the holidays"): no nudge before this
     * instant (the start of that day in the owner's zone). Set from the classifier's
     * `wait_until` and replaced at every new customer email (cleared when it has none).
     */
    nudgeAfter: timestamp("nudge_after", { withTimezone: true }),
    /**
     * Check 21 P4: the newest email the owner sent that reads as an invoice (owner-invoice-rules,
     * found in code at sync). With `extracted.invoice_thread`, it makes the thread chased like an
     * invoice even when the customer's last email was sorted as scheduling, and lets a fresh
     * invoice email with no customer reply on it be chased.
     */
    ownerInvoiceAt: timestamp("owner_invoice_at", { withTimezone: true }),
    /**
     * Leads package (B2 / B3): where the lead came from, decided in code from the sender
     * (`channelOf`, src/server/channel-rules.ts): a phone service key ("google_voice"),
     * "phone_text" (an email-to-text gateway) or a lead-site key ("thumbtack"). Null = a direct
     * email. Set at classification; a later email on the thread doesn't clear it. Such threads
     * are never drafted by email (answered on the site or from the owner's own phone).
     */
    leadChannel: text("lead_channel"),
    /**
     * Leads package (G5): the owner tapped "Mark fixed" on a complaint. Two days later, if the
     * customer hasn't written, a "Check in" card asks whether they're happy (once per fix).
     */
    complaintFixedAt: timestamp("complaint_fixed_at", { withTimezone: true }),
    /** G5: the owner closed that check-in ("All good"). A new Mark fixed re-arms it. */
    complaintCheckinDoneAt: timestamp("complaint_checkin_done_at", { withTimezone: true }),
    /**
     * Plan M8 (A11): set when this thread is first sorted as a quote request, to the time of the
     * customer's FIRST email on the thread (what response time and the monthly counts measure
     * from). Sticky like complained_at: a customer's later "Tuesday works" re-sorts the thread
     * as scheduling, but it still counts as a quote request in the scorecard and summaries.
     * Never set from an email that tries to instruct the assistant.
     */
    quoteRequestedAt: timestamp("quote_requested_at", { withTimezone: true }),
    /**
     * Plan M8 (A11): the kind of job as one of OUR fixed labels (src/config/job-kinds.ts), never
     * the customer's words. Set at classification; null on threads sorted before it existed.
     */
    jobKind: text("job_kind"),
    /** Plan #34: when we last pushed "a lead is waiting" for this thread's current wait. */
    atRiskAlertedAt: timestamp("at_risk_alerted_at", { withTimezone: true }),
    /**
     * Replies package (B5 part 2): when the owner's phone was told about this thread's
     * emergency ("An emergency email just came in."). Once per thread, ever; never cleared.
     */
    emergencyAlertedAt: timestamp("emergency_alerted_at", { withTimezone: true }),
    /**
     * Ideas H4: the kind the owner moved this conversation to ("Wrong kind?"). It wins over the
     * sorter on every later email (written into `category` in SQL), like needs_owner_manual.
     * One of the classifier's categories, checked in code. Null = the sorter's kind stands.
     */
    categoryManual: text("category_manual"),
    /**
     * Ideas C5: why the owner says a quote was lost (price / timing / someone_else / other), one tap,
     * optional. Read only while quote_outcome = 'lost' (older code can leave a stale value).
     */
    quoteLostReason: text("quote_lost_reason").$type<LostReason>(),
    categoryManualAt: timestamp("category_manual_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("threads_mailbox_gmail_uq").on(t.mailboxId, t.gmailThreadId),
    index("threads_mailbox_last_idx").on(t.mailboxId, t.lastMessageAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    /** RFC 822 Message-ID header, needed to thread our reply drafts (In-Reply-To/References). */
    rfc822MessageId: text("rfc822_message_id"),
    references: text("references"),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    /**
     * The usable Reply-To of an inbound email (a website form's customer), chosen at sync by
     * `pickReplyTo`. NULL = never read (stored before this column, or a fetch that couldn't
     * return it); {} = read, nothing usable, the reply goes to From; {address, name?} = the
     * reply goes there. Metadata like from_address: kept past the body purge.
     */
    replyToHeader: jsonb("reply_to_header").$type<ReplyToHeader>(),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    direction: directionEnum("direction").notNull(),
    labelIds: jsonb("label_ids").$type<string[]>().notNull().default([]),
    /** Gmail's preview text. It is body text, so it is purged with the body. */
    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Set once classification ran (or was deliberately skipped) for this message. */
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    /**
     * Check 50 P3 (reserved, not read or written yet): an automatic reply (out-of-office,
     * auto-responder headers). Check 20 P4 and 21 P1 use this column and add no migration.
     */
    autoReply: boolean("auto_reply").notNull().default(false),
    /**
     * Check 50 P3 (reserved, not read or written yet): a bare acknowledgement ("thanks!") that
     * needs no answer. Check 21 P1 uses this column and adds no migration.
     */
    ackOnly: boolean("ack_only").notNull().default(false),
    /**
     * Check 40 P2: how many photos / PDFs / other files came with the email (full reads only).
     * Counts only: no file name or content is ever stored.
     */
    attachmentImages: integer("attachment_images").notNull().default(0),
    attachmentPdfs: integer("attachment_pdfs").notNull().default(0),
    attachmentOther: integer("attachment_other").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_mailbox_gmail_uq").on(t.mailboxId, t.gmailMessageId),
    index("messages_thread_sent_idx").on(t.threadId, t.sentAt),
    index("messages_retention_idx").on(t.sentAt),
  ],
);

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actor: actorEnum("actor").notNull(),
    action: text("action").notNull(),
    threadId: uuid("thread_id"),
    /** Structured, content-free detail. Never email bodies or customer personal details. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("activity_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

export const draftStatusEnum = pgEnum("draft_status", [
  "pending",
  "sent",
  "edited_and_sent",
  "discarded",
  "expired",
]);
export const draftKindEnum = pgEnum("draft_kind", ["reply", "followup"]);
/**
 * Owner-asked special replies (plan #26 #28 #29). They are kind `reply` with a purpose, so
 * follow-up counts never change. Null = an ordinary reply or follow-up.
 */
export const DRAFT_PURPOSES = [
  "deposit",
  "review_request",
  "closing_question",
  "safety",
  // Davi, 2026-10-16: "Say thanks" on a paid invoice. `thank_you_review` is the same note with
  // the review ask in it (only when every review-request rule allows one); it counts as that
  // customer's review request. Plain text column, so no migration of the values.
  "thank_you",
  "thank_you_review",
] as const;
/** The two kinds of thank-you note: once per thread between them (`drafts_one_thank_you_per_thread`). */
export const THANK_YOU_PURPOSES = ["thank_you", "thank_you_review"] as const;
export type DraftPurpose = (typeof DRAFT_PURPOSES)[number];

/**
 * A reply we wrote. It lives as a real Gmail draft (`gmail_draft_id`) so the
 * owner can see and edit it in Gmail too; we reconcile if they do.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    /** The inbound message this replies to. */
    replyToMessageId: uuid("reply_to_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    kind: draftKindEnum("kind").notNull().default("reply"),
    gmailDraftId: text("gmail_draft_id"),
    gmailMessageId: text("gmail_message_id"),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    /** Current text (after any owner edits). Purged with other bodies after the retention window. */
    body: text("body"),
    /** What we generated, to tell "sent" from "edited and sent". */
    originalBody: text("original_body"),
    status: draftStatusEnum("status").notNull().default("pending"),
    /** One line the owner sees in the queue. */
    reason: text("reason").notNull(),
    /** Things the owner should double-check before sending. */
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    confidence: integer("confidence_pct").notNull().default(0),
    /** Which profile facts / voice traits the drafter says it used (keys only — plan #1). */
    usedFacts: jsonb("used_facts").$type<string[]>().notNull().default([]),
    /** Quick tweaks / voice edits so far (plan #3: at most 5 per draft). */
    revisions: integer("revisions").notNull().default(0),
    promptVersion: text("prompt_version"),
    /** Why it left the queue without being sent from here (deleted in Gmail, superseded…). */
    closedNote: text("closed_note"),
    sentGmailMessageId: text("sent_gmail_message_id"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Autopilot: when this draft will send unless the owner holds it. Null = waits for a tap. */
    autoSendAt: timestamp("auto_send_at", { withTimezone: true }),
    /**
     * Check 9 P2: the autopilot run that is sending this right now (set atomically before any
     * Gmail call; cleared when it stands down). While set, Hold it is too late. A claim older
     * than AUTOPILOT_CLAIM_LEASE_MS belongs to a run that died and may be retaken.
     */
    autoSendClaimedAt: timestamp("auto_send_claimed_at", { withTimezone: true }),
    /**
     * Check 20 P7: why autopilot didn't start or finish a countdown on this reply, as
     * content-free codes (`src/server/autopilot-reasons.ts`). Null = never refused.
     */
    autopilotSkip: jsonb("autopilot_skip").$type<string[]>(),
    /**
     * Plan #7 undo send: the owner tapped Send reply; it goes at this time unless
     * they tap Undo. The draft stays `pending` meanwhile (so it still holds the
     * thread's one live slot) but is out of the queue. Null = not sending.
     */
    sendAfter: timestamp("send_after", { withTimezone: true }),
    /** Set by the one job allowed to send it; a stale claim (crash) can be retaken. */
    sendClaimedAt: timestamp("send_claimed_at", { withTimezone: true }),
    /** Plan #26 #28 #29: deposit / review request / closing question. Null = ordinary. */
    purpose: text("purpose").$type<DraftPurpose>(),
    /**
     * Replies package (draft.v7): a first reply to someone the owner never wrote to, and the
     * shape the drafter chose from what they said — details / vague / urgent / price_only, or
     * not_first when it didn't write one. A key, never text. Null = not a first contact (and
     * every draft written before draft.v7).
     */
    opening: text("opening"),
    /**
     * Check 43 P8: the language the customer's newest email was in ("en" | "es" | "pt", decided
     * in code; null = couldn't tell) and the one this reply was written for. Codes only.
     */
    customerLanguage: text("customer_language"),
    replyLanguage: text("reply_language"),
    /**
     * Check 14 P1: how a sent draft left. app = the owner's tap here, autopilot = autopilot,
     * gmail = our draft sent from Gmail (same or edited text), own_words = closed because the
     * owner wrote their own reply in Gmail (status stays `sent` so caps hold, but it never counts
     * as a drafted reply sent or as time saved). Null = sent before this column (counted as
     * before).
     */
    sentVia: text("sent_via").$type<"app" | "autopilot" | "gmail" | "own_words">(),
  },
  (t) => [
    index("drafts_mailbox_status_idx").on(t.mailboxId, t.status),
    // At most one live draft per thread.
    uniqueIndex("drafts_one_pending_per_thread")
      .on(t.threadId)
      .where(sql`status = 'pending'`),
    // Plan #26: "did you go another way?" is asked once per thread, ever (any status).
    uniqueIndex("drafts_one_closing_question_per_thread")
      .on(t.threadId)
      .where(sql`purpose = 'closing_question'`),
    // "Say thanks" (2026-10-16): once per thread. One that went stale (the customer wrote
    // again before the owner tapped anything) doesn't count.
    uniqueIndex("drafts_one_thank_you_per_thread")
      .on(t.threadId)
      .where(sql`purpose in ('thank_you', 'thank_you_review') and status <> 'expired'`),
  ],
);

/** What the owner tells us about the business. Drives classification and drafting. */
export const businessProfiles = pgTable("business_profile", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  services: text("services"),
  serviceArea: text("service_area"),
  hours: text("hours"),
  leadTime: text("lead_time"),
  pricingNotes: text("pricing_notes"),
  paymentTerms: text("payment_terms"),
  policies: text("policies"),
  signature: text("signature"),
  /** Plan #29: where happy customers leave a review (https only). Added to a draft only on a tap. */
  reviewUrl: text("review_url"),
  doNotPromise: jsonb("do_not_promise").$type<string[]>().notNull().default([]),
  vipSenders: jsonb("vip_senders").$type<string[]>().notNull().default([]),
  /** The owner's "Never say this" list (plan #23). Kept apart from the learned voice so a re-learn can't drop it. */
  neverSay: jsonb("never_say").$type<string[]>().notNull().default([]),
  /** The owner hid the getting-started checklist (only offered once every step is done). */
  onboardingDismissedAt: timestamp("onboarding_dismissed_at", { withTimezone: true }),
  /**
   * Check 9 P13: when every getting-started step was first all done (cleared if a step
   * un-does). The finished list folds to one line, and hides itself 3 days after this.
   */
  onboardingDoneAt: timestamp("onboarding_done_at", { withTimezone: true }),
  /** Round 2 (FW D1/D2): the owner hid the "your last 30 days" card on the queue. */
  firstLookHiddenAt: timestamp("first_look_hidden_at", { withTimezone: true }),
  /**
   * Leads package (B9): the towns the owner works in, exact, one per entry. Empty = no check.
   * Quote requests whose job town (parsed in code from the address) isn't on it get a line.
   */
  serviceTowns: jsonb("service_towns").$type<string[]>().notNull().default([]),
  /** Emails mentioning more than this go to the owner. */
  amountThresholdDollars: integer("amount_threshold_dollars").notNull().default(2500),
  /** Nudge quiet quotes and invoices after this many days without a reply. */
  followupsEnabled: boolean("followups_enabled").notNull().default(true),
  followupDays: integer("followup_days").notNull().default(3),
  /**
   * Check 38 P4: for quotes over the money limit, wait this many days instead (7, 10, 14 or 21).
   * Null = the same as `followup_days`.
   */
  bigQuoteDays: integer("big_quote_days"),
  /** Morning digest: on/off, the owner's local hour, their time zone, last local date sent. */
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  digestHour: integer("digest_hour").notNull().default(7),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  /**
   * Check 45 P1 / 44 P5: where time_zone came from — 'default' (never set: the schema default),
   * 'browser' (setup, or the first signed-in page load while still 'default') or 'owner' (picked
   * on Settings → Morning email). A browser never replaces an 'owner' zone.
   */
  timeZoneSource: text("time_zone_source").$type<TimeZoneSource>().notNull().default("default"),
  /**
   * Check 15 P8: the hours the "a lead is waiting" alerts count (ISO weekdays, local hours,
   * end exclusive; 24 = midnight). Defaults are the old fixed schedule (Mon–Sat 7am–6pm), so
   * nothing changes until the owner edits. The free-text `hours` is what drafts say.
   */
  workDays: integer("work_days").array().notNull().default([1, 2, 3, 4, 5, 6]),
  workStartHour: integer("work_start_hour").notNull().default(7),
  workEndHour: integer("work_end_hour").notNull().default(18),
  /**
   * Check 43 P8: the languages the owner answers customers in. English always; "es" / "pt"
   * only when switched on (the owner can read a reply in it before sending).
   */
  replyLanguages: text("reply_languages").array().notNull().default(["en"]),
  digestLastSentOn: text("digest_last_sent_on"),
  /** Text alerts to the owner's own phone (E.164, e.g. +15085551234). Off until they opt in. */
  alertPhone: text("alert_phone"),
  /** Set once the owner typed back the code we texted; alerts only go to a verified number. */
  alertPhoneVerifiedAt: timestamp("alert_phone_verified_at", { withTimezone: true }),
  /** sha256 of the 6-digit code + its expiry; cleared once used. */
  smsCodeHash: text("sms_code_hash"),
  smsCodeExpiresAt: timestamp("sms_code_expires_at", { withTimezone: true }),
  /** Check 19 P9: wrong guesses at the current code; the fifth throws the code away. */
  smsCodeTries: integer("sms_code_tries").notNull().default(0),
  smsAlertsEnabled: boolean("sms_alerts_enabled").notNull().default(false),
  /** Newest classification already covered by a text, and when the last text went out. */
  smsAlertCursor: timestamp("sms_alert_cursor", { withTimezone: true }),
  /**
   * Replies package (B5 part 2): "Emergencies, even at night". On by default: an emergency
   * reaches the owner's phone (notifications and texts they switched on) at once, quiet hours
   * or not, within its own caps. Off = emergencies wait like any other email.
   */
  emergencyAlertsEnabled: boolean("emergency_alerts_enabled").notNull().default(true),
  /** Plan #36 phone notifications: same throttle and cursor as texts, kept apart. */
  pushLastSentAt: timestamp("push_last_sent_at", { withTimezone: true }),
  pushAlertCursor: timestamp("push_alert_cursor", { withTimezone: true }),
  smsLastSentAt: timestamp("sms_last_sent_at", { withTimezone: true }),
  /**
   * Check 19 P6: why texts switched themselves off — 'opted_out' (the owner replied STOP,
   * Twilio 21610) or 'not_mobile' (30006, the number can't take texts). Cleared when the
   * owner turns texts on again or starts a new number.
   */
  smsStoppedReason: text("sms_stopped_reason"),
  /** Plan #35: the owner's local month ('YYYY-MM') last summarized (sent, or skipped as empty). */
  monthlySummaryLastSentFor: text("monthly_summary_last_sent_for"),
  /**
   * Ideas E7 away mode: the owner's first day back, as their local date (YYYY-MM-DD). Away while
   * that day hasn't come yet (read at use, no job turns it off). Null = not away.
   */
  awayBackOn: text("away_back_on"),
  /**
   * Check 50 P3: the owner's two-letter US state code. Written by the business profile form and
   * read by the Massachusetts deposit rule since Check 38 P2; 44 P1 and 45 P2 use it too and
   * add no migration.
   */
  state: text("state"),
  /**
   * Check 50 P3 (reserved, not shown in any form yet): the owner's crew addresses, lowercased,
   * de-duplicated, max 30 (`crewAddressesSchema` in src/server/profile.ts). Check 22 P10 and
   * 41 P6 use this one list (not a "team_addresses") and add no migration.
   */
  crewAddresses: text("crew_addresses")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /**
   * Check 38 P6: registration and license numbers as the owner typed them (src/config/licenses.ts).
   * Drafts quote only these; the draft check flags any other number or unbacked claim.
   */
  licenses: jsonb("licenses").$type<Licenses>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceSourceEnum = pgEnum("voice_source", ["learned", "edited"]);
export const voiceStatusEnum = pgEnum("voice_status", [
  "learning",
  "ready",
  "not_enough_mail",
  "failed",
]);

/**
 * How the owner writes, learned from sent mail and editable in Settings.
 * `examples` are short samples the model writes *in* the owner's style with
 * customer details removed — not copies of real emails — so nothing here is
 * email content subject to the 30-day purge.
 */
export const voiceProfiles = pgTable("voice_profile", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  status: voiceStatusEnum("status").notNull().default("learning"),
  source: voiceSourceEnum("source").notNull().default("learned"),
  summary: text("summary"),
  greetingStyle: text("greeting_style"),
  signoffStyle: text("signoff_style"),
  avgLengthWords: integer("avg_length_words"),
  formality: text("formality"),
  phrasesUsed: jsonb("phrases_used").$type<string[]>().notNull().default([]),
  phrasesAvoided: jsonb("phrases_avoided").$type<string[]>().notNull().default([]),
  examples: jsonb("examples").$type<string[]>().notNull().default([]),
  learnedFromCount: integer("learned_from_count").notNull().default(0),
  learnedAt: timestamp("learned_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Check 24 P1: how the newest learn went (learning | ready | not_enough_mail | failed | capped |
   * reconnect_needed), apart from `status`, which stays "ready" while a voice is stored.
   */
  lastAttempt: text("last_attempt"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  /** Check 29 P2: times the 15-minute backstop restarted a learn stuck at "learning". */
  restartCount: integer("restart_count").notNull().default(0),
  /** Check 24 P6: the inbox the stored voice was learned from ("Learned from mike@…"). */
  // No foreign key on purpose: the voice belongs to the account and stays when that Gmail is
  // disconnected (verification-doc / data-lifecycle tests); the screen just stops naming it.
  learnedFromMailboxId: uuid("learned_from_mailbox_id"),
  /**
   * Check 24 P8: greeting, sign-off, formality or length changed since the sample replies were
   * written, so drafts get no samples until new ones are written.
   */
  examplesStale: boolean("examples_stale").notNull().default(false),
  /** Check 24 P12: the UTC day of the backstop's retries of a failed first learn, and how many. */
  retryDay: text("retry_day"),
  retriesThatDay: integer("retries_that_day").notNull().default(0),
});

/**
 * AI usage per workspace per UTC day. Drives the daily call cap and the
 * per-customer monthly cost Davi sees in /admin. Never holds content.
 */
export const usage = pgTable(
  "usage",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** UTC date, YYYY-MM-DD. Monthly figures are sums over this. */
    period: text("period").notNull(),
    aiCalls: integer("ai_calls").notNull().default(0),
    modelTokensIn: integer("model_tokens_in").notNull().default(0),
    modelTokensOut: integer("model_tokens_out").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    draftsCreated: integer("drafts_created").notNull().default(0),
    emailsSent: integer("emails_sent").notNull().default(0),
    /** Hundredths of a cent, so tiny Haiku calls don't round to zero. */
    estimatedCostCentiCents: integer("estimated_cost_centicents").notNull().default(0),
    /** Check 48 P3: calls answered by the role's approved stand-in model (models.ts). */
    fallbackCalls: integer("fallback_calls").notNull().default(0),
    capAlertedAt: timestamp("cap_alerted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("usage_workspace_period_uq").on(t.workspaceId, t.period)],
);

/**
 * Seasonal notes (plan #25): short notes with an end date — "Booked through
 * November", "On vacation Aug 1–10". In the drafting prompt only while active.
 */
export const seasonalNotes = pgTable(
  "seasonal_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Last day the note applies, in the owner's local calendar (YYYY-MM-DD). */
    endsOn: text("ends_on").notNull(),
    /** Ideas E7: the one note away mode writes ("Away until …"). Not counted in the 5. */
    away: boolean("away").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("seasonal_notes_workspace_idx").on(t.workspaceId, t.endsOn),
    uniqueIndex("seasonal_notes_one_away")
      .on(t.workspaceId)
      .where(sql`away`),
  ],
);

/** Ideas H3: what a sender rule does. `needs_me` is company-wide only (an address is a VIP). */
export const OWNER_SENDER_RULE_ACTIONS = ["junk", "no_draft", "needs_me"] as const;
export type OwnerSenderRuleAction = (typeof OWNER_SENDER_RULE_ACTIONS)[number];
export const OWNER_SENDER_RULE_SCOPES = ["address", "domain"] as const;
export type OwnerSenderRuleScope = (typeof OWNER_SENDER_RULE_SCOPES)[number];

/**
 * Ideas H3: the owner's own rules for a sender — one address or everyone at a company's web
 * address. Never sent to the AI. Goes with the workspace (Delete my account).
 */
export const ownerSenderRules = pgTable(
  "owner_sender_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** 'dana@example.com' or 'hillpm.com', lowercased. */
    pattern: text("pattern").notNull(),
    scope: text("scope").$type<OwnerSenderRuleScope>().notNull(),
    action: text("action").$type<OwnerSenderRuleAction>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("owner_sender_rules_workspace_pattern_uq").on(t.workspaceId, t.pattern),
    check("owner_sender_rules_action", sql`${t.action} in ('junk', 'no_draft', 'needs_me')`),
    check("owner_sender_rules_scope", sql`${t.scope} in ('address', 'domain')`),
    check(
      "owner_sender_rules_needs_me_domain",
      sql`${t.action} <> 'needs_me' or ${t.scope} = 'domain'`,
    ),
  ],
);

/**
 * Ideas G7: the owner's private note about a customer (gate code, dog, best time to call).
 * Only the owner sees it: never sent to customers or the AI, never in alerts, emails or admin.
 * Goes with the Gmail address it was written under (disconnect) and the workspace.
 */
export const customerNotes = pgTable(
  "customer_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    /** The customer's reply address, lowercased. */
    address: text("address").notNull(),
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_notes_workspace_address_uq").on(t.workspaceId, t.address),
    check("customer_notes_body_len", sql`char_length(${t.body}) between 1 and 200`),
  ],
);

/**
 * Plan #21: what one edited send changed — counts and yes/no only, never the
 * words. One row per draft. Kept after the draft text is purged.
 */
export const editSignals = pgTable(
  "edit_signals",
  {
    draftId: uuid("draft_id")
      .primaryKey()
      .references(() => drafts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    wordsBefore: integer("words_before").notNull(),
    wordsAfter: integer("words_after").notNull(),
    openingChanged: boolean("opening_changed").notNull(),
    signoffChanged: boolean("signoff_changed").notNull(),
    firstSentenceCut: boolean("first_sentence_cut").notNull(),
    sentencesRemoved: integer("sentences_removed").notNull(),
    sentencesAdded: integer("sentences_added").notNull(),
    /** none | warmer | cooler | more_formal | more_casual; null if the model call failed. */
    toneShift: text("tone_shift"),
    createdAt: createdAt(),
  },
  (t) => [index("edit_signals_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/** Plan #21: an idea from the owner's edits. Nothing changes until they say yes. */
export const voiceSuggestions = pgTable(
  "voice_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** The plain-language question, built from counts only. */
    text: text("text").notNull(),
    targetWords: integer("target_words"),
    /** open | accepted | ignored */
    status: text("status").notNull().default("open"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("voice_suggestions_workspace_idx").on(t.workspaceId, t.status)],
);

/**
 * Plan #36: phones that asked for notifications. Only the push service's
 * endpoint — we send empty pushes, so no encryption keys are kept.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    createdAt: createdAt(),
    /**
     * Check 19 P5: pushes this phone's push service refused in a row (any non-2xx but 404/410,
     * 403 included), and when the run started. Reset by a delivered push; a row failing for
     * 7 days is deleted.
     */
    failCount: integer("fail_count").notNull().default(0),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint)],
);

/**
 * Check 19 P6: what Twilio said about each text we sent the owner (status callbacks). No body
 * and no phone number: the message's id, which kind it was, its status and Twilio's error
 * code. Purged after 30 days.
 */
export const smsDeliveries = pgTable(
  "sms_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageSid: text("message_sid").notNull(),
    /** 'code' | 'alert'. */
    kind: text("kind").notNull(),
    /** Twilio's MessageStatus: queued, sent, delivered, undelivered, failed … */
    status: text("status").notNull().default("queued"),
    errorCode: integer("error_code"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sms_deliveries_message_sid_uq").on(t.messageSid),
    index("sms_deliveries_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

/** App-wide settings Davi's admin tools write (e.g. the Stripe webhook secret, encrypted). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Stripe events already handled — webhooks can arrive more than once. */
/**
 * Fixed-window abuse limits (src/server/rate-limit.ts). Keys are a purpose
 * plus a workspace id or a hashed IP — never an email or a raw address.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

/**
 * Check 25 P1: Gmail quota units used per mailbox per minute (Google allows 6,000 a minute per
 * user; we stop at 5,400). One atomic upsert per request, shared by every job for the inbox.
 * Counts only. Purged daily.
 */
export const gmailUnits = pgTable(
  "gmail_units",
  {
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    units: integer("units").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.minute] })],
);

/**
 * Check 25 P4: background job runs and steps per function per UTC day (Inngest bills both).
 * Counts only, from an Inngest middleware; /admin shows the month's total.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    functionId: text("function_id").notNull(),
    day: date("day").notNull(),
    runs: integer("runs").notNull().default(0),
    steps: integer("steps").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.functionId, t.day] })],
);

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Plan #15 price memory: what the owner quoted for a kind of job, one row per quote thread.
 * Owner-only. Never sent to the AI and never shown outside the queue/inbox quote items
 * (enforced by a static test). Goes with the thread (disconnect) or the workspace (delete).
 */
export const priceHistory = pgTable(
  "price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** The kind of job (classification's service_requested), not the customer's words. */
    service: text("service").notNull(),
    amountCents: integer("amount_cents").notNull(),
    quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("price_history_thread_uq").on(t.threadId),
    index("price_history_ws_quoted_idx").on(t.workspaceId, t.quotedAt),
  ],
);

export type PriceHistory = typeof priceHistory.$inferSelect;

/** Plan #47: who a referral credit is for — the owner who shared the link, or the new owner. */
export const REFERRAL_SIDES = ["referrer", "referred"] as const;
export type ReferralSide = (typeof REFERRAL_SIDES)[number];
/**
 * Plan #47 offer A (Davi, 2026-10-15): the referrer's next month free, one plan up.
 * pending = earned, waiting to be booked on the referrer's subscription (no plan yet, account
 * off, another free month first, or Stripe busy); scheduled = the coupon is on the subscription
 * and makes the next renewal's plan line free; running = the free month itself
 * ([starts_at, ends_at), `workspaces.free_plan` set); done = it ended and the plan effects ran;
 * failed = Stripe used it early or refused the coupon (/admin, by hand); skipped = settled with
 * nothing to give (`skip_reason`). applied = legacy (the old balance credit; never written now).
 */
export const REFERRAL_CREDIT_STATUSES = [
  "pending",
  "scheduled",
  "running",
  "done",
  "failed",
  "skipped",
  "applied",
] as const;
export type ReferralCreditStatus = (typeof REFERRAL_CREDIT_STATUSES)[number];

/** What a reward row gives. `balance_credit` = legacy rows only. */
export const REFERRAL_REWARD_KINDS = ["balance_credit", "free_month_up"] as const;
export type ReferralRewardKind = (typeof REFERRAL_REWARD_KINDS)[number];

/** Why a referral was settled with nothing to give. */
export const REFERRAL_SKIP_REASONS = ["off", "self", "same_domain", "house"] as const;
export type ReferralSkipReason = (typeof REFERRAL_SKIP_REASONS)[number];

/** The latest thing /admin should look at on a reward row (a fixed code, never text). */
export const REFERRAL_ADMIN_FLAGS = [
  "renewed_without_discount",
  "discount_removed",
  "plan_changed_in_free_month",
  "charged_for_free_days",
  "invoice_not_final",
  "discount_lingered",
  "unknown_price",
  "not_fully_free",
  "free_day_charges_removed",
  "second_month_given",
  "free_invoice_lost_discount",
] as const;
export type ReferralAdminFlag = (typeof REFERRAL_ADMIN_FLAGS)[number];

/**
 * Plan #47 referral credits. Each referral is settled once, the first time the referred
 * workspace becomes active: one row per side paid (or one `skipped` row). Rows outlive account
 * deletion (workspace ids go null) and are keyed by a salted hash of the referred owner's
 * email, so deleting an account and signing up again can't earn a second credit.
 * No names, emails or customer data.
 */
export const referralCredits = pgTable(
  "referral_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referredWorkspaceId: uuid("referred_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    /** sha256 of the referred owner's normalized email, salted with AUTH_SECRET. */
    referredEmailSha256: text("referred_email_sha256").notNull(),
    beneficiaryWorkspaceId: uuid("beneficiary_workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    side: text("side").$type<ReferralSide>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<ReferralCreditStatus>().notNull().default("pending"),
    stripeBalanceTransactionId: text("stripe_balance_transaction_id"),
    /** Tries at Stripe that failed, and the last Stripe error code (a fixed code, never text). */
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    // --- Plan #47 offer A: a free month, one plan up (0032; every column nullable or defaulted).
    /** `free_month_up` for everything new code writes; legacy rows keep the default. */
    reward: text("reward").$type<ReferralRewardKind>().notNull().default("balance_credit"),
    /** 'live' / 'test': the Stripe key's mode when it settled. A test reward never goes live. */
    stripeMode: text("stripe_mode").$type<"live" | "test">(),
    skipReason: text("skip_reason").$type<ReferralSkipReason>(),
    /** What it went on in Stripe, and the invoice that used it. Ids only. */
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeCouponId: text("stripe_coupon_id"),
    stripeDiscountId: text("stripe_discount_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    /** `Discount.start` (Stripe's clock, so Test Clocks work). */
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    /** When the invoice that used it was seen finalized (null while running = provisional). */
    invoiceFinalAt: timestamp("invoice_final_at", { withTimezone: true }),
    /** A 2-minute lease for attach / detach / strip / Keep / Go back. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Bumped on each Keep / Go back claim: part of that tap's Stripe idempotency key. */
    planChangeSeq: integer("plan_change_seq").notNull().default(0),
    /** What the free month's plan line billed: the plan, its price id and unit amount. */
    paidPlan: planEnum("paid_plan"),
    paidPriceId: text("paid_price_id"),
    paidPriceCents: integer("paid_price_cents"),
    /** `planAbove(paid_plan)`. */
    freePlan: planEnum("free_plan"),
    /** The expected start while scheduled; the plan line's period once running. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** The owner's "Keep" tap, and the price they confirmed. */
    keptAt: timestamp("kept_at", { withTimezone: true }),
    keptPriceCents: integer("kept_price_cents"),
    /** When `done` ran. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /**
     * When the Stripe follow-up after `done` (strip our coupon if it stayed on, sweep or flag
     * charges for free days) fully went through. Null on a done row = the sweep tries again (0045).
     */
    afterEndCheckedAt: timestamp("after_end_checked_at", { withTimezone: true }),
    /** The subscription's billing mode (`flexible` / `classic`), for /admin. */
    billingMode: text("billing_mode"),
    /** The latest thing /admin should look at, and when it was raised. */
    adminFlag: text("admin_flag").$type<ReferralAdminFlag>(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
  },
  (t) => [
    // Once per referral, ever.
    uniqueIndex("referral_credits_email_side_uq").on(t.referredEmailSha256, t.side),
    index("referral_credits_status_idx").on(t.status),
    // One free month at a time: at most one booked and one running per workspace.
    uniqueIndex("referral_credits_one_scheduled_uq")
      .on(t.beneficiaryWorkspaceId)
      .where(sql`status = 'scheduled'`),
    uniqueIndex("referral_credits_one_running_uq")
      .on(t.beneficiaryWorkspaceId)
      .where(sql`status = 'running'`),
  ],
);
export type ReferralCredit = typeof referralCredits.$inferSelect;

/** Squared Away Growth (2026-10-16): where a client stands. Only active and paused see the portal. */
export const GROWTH_CLIENT_STATUSES = ["active", "paused", "ended"] as const;
export type GrowthClientStatus = (typeof GROWTH_CLIENT_STATUSES)[number];

/**
 * Squared Away Growth clients: an account Davi does Growth work for (ads, posts, Google
 * Business Profile, reviews, websites). One per workspace; goes with it (Delete my account).
 * Nothing here comes from email.
 */
export const growthClients = pgTable(
  "growth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").$type<GrowthClientStatus>().notNull().default("active"),
    /** The day Growth work began, a calendar date (the owner's own calendar). */
    startedOn: date("started_on", { mode: "string" }).notNull(),
    /** Ids from GROWTH_SERVICES (src/config/growth.ts), checked in code. */
    services: text("services").array().$type<GrowthService[]>().notNull().default([]),
    /**
     * The client's time zone for their dashboard's months, set by Davi in /admin. Growth never
     * reads the inbox app's business profile (Growth never uses inbox data).
     */
    timeZone: text("time_zone").notNull().default("America/New_York"),
    createdAt: createdAt(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("growth_clients_workspace_uq").on(t.workspaceId),
    check("growth_clients_status", sql`${t.status} in ('active', 'paused', 'ended')`),
  ],
);
export type GrowthClient = typeof growthClients.$inferSelect;

/**
 * Davi's updates to a Growth client, in his own words (never anything from email). Emailed once
 * (`notified_at` set only after the email went out).
 */
export const growthUpdates = pgTable(
  "growth_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    growthClientId: uuid("growth_client_id")
      .notNull()
      .references(() => growthClients.id, { onDelete: "cascade" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    index("growth_updates_client_idx").on(t.growthClientId, t.postedAt),
    check("growth_updates_title_len", sql`char_length(${t.title}) between 1 and 80`),
    check("growth_updates_body_len", sql`char_length(${t.body}) between 1 and 2000`),
  ],
);
export type GrowthUpdate = typeof growthUpdates.$inferSelect;

/**
 * The numbers Davi enters after each monthly check-in with a Growth client, one row per month
 * ('YYYY-MM', the client's own calendar). Every number is optional: blank = not entered.
 */
export const growthMonthly = pgTable(
  "growth_monthly",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    growthClientId: uuid("growth_client_id")
      .notNull()
      .references(() => growthClients.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    newLeads: integer("new_leads"),
    calls: integer("calls"),
    jobsWon: integer("jobs_won"),
    moneyWonCents: integer("money_won_cents"),
    reviewsGained: integer("reviews_gained"),
    adSpendCents: integer("ad_spend_cents"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("growth_monthly_client_month_uq").on(t.growthClientId, t.month),
    check("growth_monthly_month", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "growth_monthly_not_negative",
      sql`coalesce(${t.newLeads}, 0) >= 0 and coalesce(${t.calls}, 0) >= 0 and coalesce(${t.jobsWon}, 0) >= 0 and coalesce(${t.moneyWonCents}, 0) >= 0 and coalesce(${t.reviewsGained}, 0) >= 0 and coalesce(${t.adSpendCents}, 0) >= 0`,
    ),
    check("growth_monthly_note_len", sql`${t.note} is null or char_length(${t.note}) <= 280`),
  ],
);
export type GrowthMonthly = typeof growthMonthly.$inferSelect;
export type User = typeof users.$inferSelect;
export type BusinessProfile = typeof businessProfiles.$inferSelect;
export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export const ruleModeEnum = pgEnum("rule_mode", ["draft", "autopilot"]);

/**
 * Per-category rules. Only `autopilot` changes behaviour today: replies in that
 * category may send on their own after a grace window, if every guardrail in
 * `src/server/autopilot.ts` passes. Absent row = `draft` (wait for a tap).
 */
export const rules = pgTable(
  "rules",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    mode: ruleModeEnum("mode").notNull().default("draft"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rules_workspace_category_uq").on(t.workspaceId, t.category)],
);

export type Rule = typeof rules.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
