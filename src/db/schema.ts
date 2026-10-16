/**
 * Drizzle schema. Tables are added milestone by milestone; migrations are
 * generated into /drizzle with `pnpm db:generate` and checked in.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { TRADES, type Trade } from "../config/trades";
import type { LostReason } from "../server/quote-rules";
import type { ReplyToHeader } from "../server/reply-address-rules";

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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_workspace_email_uq").on(t.workspaceId, sql`lower(${t.email})`),
    index("mailboxes_workspace_idx").on(t.workspaceId),
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
     * What the job was quoted at, in cents: taken from the owner's own reply (largest $ figure,
     * captured before bodies are purged) or typed by the owner. Kept after the purge.
     */
    quoteAmountCents: integer("quote_amount_cents"),
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
     * Ideas H4: the kind the owner moved this conversation to ("Wrong kind?"). It wins over the
     * sorter on every later email (written into `category` in SQL), like needs_owner_manual.
     * One of the classifier's categories, checked in code. Null = the sorter's kind stands.
     */
    categoryManual: text("category_manual"),
    /**
     * Ideas C5: why the owner says a quote was lost (price / timing / someone_else), one tap,
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
export const DRAFT_PURPOSES = ["deposit", "review_request", "closing_question", "safety"] as const;
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
     * Plan #7 undo send: the owner tapped Send reply; it goes at this time unless
     * they tap Undo. The draft stays `pending` meanwhile (so it still holds the
     * thread's one live slot) but is out of the queue. Null = not sending.
     */
    sendAfter: timestamp("send_after", { withTimezone: true }),
    /** Set by the one job allowed to send it; a stale claim (crash) can be retaken. */
    sendClaimedAt: timestamp("send_claimed_at", { withTimezone: true }),
    /** Plan #26 #28 #29: deposit / review request / closing question. Null = ordinary. */
    purpose: text("purpose").$type<DraftPurpose>(),
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
  /** Morning digest: on/off, the owner's local hour, their time zone, last local date sent. */
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  digestHour: integer("digest_hour").notNull().default(7),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  digestLastSentOn: text("digest_last_sent_on"),
  /** Text alerts to the owner's own phone (E.164, e.g. +15085551234). Off until they opt in. */
  alertPhone: text("alert_phone"),
  /** Set once the owner typed back the code we texted; alerts only go to a verified number. */
  alertPhoneVerifiedAt: timestamp("alert_phone_verified_at", { withTimezone: true }),
  /** sha256 of the 6-digit code + its expiry; cleared once used. */
  smsCodeHash: text("sms_code_hash"),
  smsCodeExpiresAt: timestamp("sms_code_expires_at", { withTimezone: true }),
  smsAlertsEnabled: boolean("sms_alerts_enabled").notNull().default(false),
  /** Newest classification already covered by a text, and when the last text went out. */
  smsAlertCursor: timestamp("sms_alert_cursor", { withTimezone: true }),
  /** Plan #36 phone notifications: same throttle and cursor as texts, kept apart. */
  pushLastSentAt: timestamp("push_last_sent_at", { withTimezone: true }),
  pushAlertCursor: timestamp("push_alert_cursor", { withTimezone: true }),
  smsLastSentAt: timestamp("sms_last_sent_at", { withTimezone: true }),
  /** Plan #35: the owner's local month ('YYYY-MM') last summarized (sent, or skipped as empty). */
  monthlySummaryLastSentFor: text("monthly_summary_last_sent_for"),
  /**
   * Ideas E7 away mode: the owner's first day back, as their local date (YYYY-MM-DD). Away while
   * that day hasn't come yet (read at use, no job turns it off). Null = not away.
   */
  awayBackOn: text("away_back_on"),
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
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint)],
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
 * pending = waiting to be added in Stripe (e.g. no Stripe customer yet); applied = added;
 * failed = Stripe refused it for good (shown in /admin, never retried); skipped = the referral
 * was settled with nothing to pay (the feature was off or had no amount when it went active).
 */
export const REFERRAL_CREDIT_STATUSES = ["pending", "applied", "failed", "skipped"] as const;
export type ReferralCreditStatus = (typeof REFERRAL_CREDIT_STATUSES)[number];

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
  },
  (t) => [
    // Once per referral, ever.
    uniqueIndex("referral_credits_email_side_uq").on(t.referredEmailSha256, t.side),
    index("referral_credits_status_idx").on(t.status),
  ],
);
export type ReferralCredit = typeof referralCredits.$inferSelect;
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
