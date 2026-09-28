/**
 * Drizzle schema. Tables are added milestone by milestone; migrations are
 * generated into /drizzle with `pnpm db:generate` and checked in.
 */
import { sql } from "drizzle-orm";
import {
  index,
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_workspace_email_uq").on(t.workspaceId, sql`lower(${t.email})`),
    index("mailboxes_workspace_idx").on(t.workspaceId),
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

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
