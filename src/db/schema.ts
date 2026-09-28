/**
 * Drizzle schema. Tables are added milestone by milestone; migrations are
 * generated into /drizzle with `pnpm db:generate` and checked in.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
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

export const tradeEnum = pgEnum("trade", ["carpentry", "plumbing", "electrical", "other"]);

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
});

/** Sign-in is invite-only. Davi adds rows here (script now, /admin in Milestone 6). */
export const invites = pgTable("invites", {
  email: text("email").primaryKey(),
  trade: tradeEnum("trade"),
  note: text("note"),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
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
    status: workspaceStatusEnum("status").notNull().default("invited"),
    evaluationStartedAt: timestamp("evaluation_started_at", { withTimezone: true }),
    evaluationEndsAt: timestamp("evaluation_ends_at", { withTimezone: true }),
    setupPaidAt: timestamp("setup_paid_at", { withTimezone: true }),
    setupCallCompletedAt: timestamp("setup_call_completed_at", { withTimezone: true }),
    plan: planEnum("plan"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: createdAt(),
  },
  // One owner per workspace for the MVP.
  (t) => [uniqueIndex("workspaces_owner_uq").on(t.ownerUserId)],
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_workspace_email_uq").on(t.workspaceId, sql`lower(${t.email})`),
    index("mailboxes_workspace_idx").on(t.workspaceId),
  ],
);

export const directionEnum = pgEnum("direction", ["in", "out"]);

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
    /** One-sentence summary from classification. Kept after bodies are purged. */
    summary: text("summary"),
    /** Structured facts pulled from the latest inbound message (service, address, dates, amounts). */
    extracted: jsonb("extracted").$type<Record<string, unknown>>(),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    awaitingReplySince: timestamp("awaiting_reply_since", { withTimezone: true }),
    followupCount: integer("followup_count").notNull().default(0),
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
  doNotPromise: jsonb("do_not_promise").$type<string[]>().notNull().default([]),
  vipSenders: jsonb("vip_senders").$type<string[]>().notNull().default([]),
  /** Emails mentioning more than this go to the owner. */
  amountThresholdDollars: integer("amount_threshold_dollars").notNull().default(2500),
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

export type User = typeof users.$inferSelect;
export type BusinessProfile = typeof businessProfiles.$inferSelect;
export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
