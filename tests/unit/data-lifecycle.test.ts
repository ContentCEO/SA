import { randomBytes } from "node:crypto";
import { eq, inArray, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import * as schema from "@/db/schema";
import {
  activityLog,
  appSettings,
  businessProfiles,
  customerNotes,
  drafts,
  editSignals,
  growthClients,
  growthMonthly,
  growthUpdates,
  invites,
  mailboxes,
  messages,
  ownerSenderRules,
  priceHistory,
  pushSubscriptions,
  rateLimits,
  gmailUnits,
  jobRuns,
  referralCredits,
  rules,
  seasonalNotes,
  stripeEvents,
  threads,
  usage,
  voiceProfiles,
  voiceSuggestions,
  waitlist,
  workspaces,
} from "@/db/schema";
import type { MailboxConnector } from "@/mailbox/connector";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import { deleteAccount } from "@/server/account-deletion";
import { listActivity } from "@/server/activity";
import { setStripeForTests } from "@/server/billing";
import { disconnectMailbox, saveConnectedMailbox } from "@/server/mailboxes";
import { listMoney } from "@/server/money";
import { purgeExpiredBodies } from "@/server/sync";
import { inviteFromWaitlist, listWaitlist } from "@/server/waitlist";
import { createTestDb } from "../support/db";

/**
 * Plan M11 S3: every table has a decided lifecycle. Delete my account removes everything the
 * owner's account holds (the cascade from `users`), disconnect removes what came from that
 * Gmail address, and the 30-day purge removes email text wherever it was copied.
 */

const NOW = new Date("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let database: Database;
beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
});
afterEach(() => setStripeForTests(undefined));

const allTables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const nameOf = (t: PgTable) => getTableConfig(t).name;

/**
 * Tables that are NOT removed by the cascade from `users`, each with the reason. Delete my
 * account handles the ones that name the owner itself (see account-deletion.ts).
 */
const KEPT: Record<string, string> = {
  invites:
    "keyed by email, no workspace; deleteAccount deletes the owner's invite (coming back needs a new one)",
  waitlist:
    "public-site entry, may hold a Growth call request (a separate service); kept until the person asks",
  app_settings:
    "global settings and markers; deleteAccount deletes the workspace's cost-alert and sent-email markers. Left: the per-mailbox done markers `cleanup:draft-messages-v1:<mailbox id>` and `backfill:reply-to-v1:<mailbox id>` (content-free uuids, never read once the mailbox is gone)",
  rate_limits: "counters keyed by workspace or hashed IP; purged daily after 2 days",
  stripe_events: "Stripe event ids and types only, for webhook idempotency",
  job_runs:
    "background job run and step counts per job name and day (Check 25 P4); no workspace, no content; purged after about four months",
  referral_credits:
    "salted email fingerprint with the workspace ids cleared (SET NULL), so a referral is paid once",
};

/** Reviewed foreign keys that are SET NULL on purpose (A6). Any other non-cascade FK fails. */
const SET_NULL: Record<string, string> = {
  "drafts.reply_to_message_id":
    "a draft can outlive the message row it answered (the stored-draft cleanup re-points it); the draft itself goes with its thread",
  "workspaces.referred_by_workspace_id":
    "a referrer deleting their account must never delete the account they referred",
  "invites.referred_by_workspace_id":
    "an invite outlives the referrer's account; the invitee still signs in, unlinked",
  "referral_credits.referred_workspace_id":
    "the credit record outlives the referred account so the same email is never paid twice",
  "referral_credits.beneficiary_workspace_id":
    "the credit record outlives the referrer's account (it was already paid or is skipped)",
};

type Edge = { table: string; column: string; parent: string; onDelete: string };

function schemaEdges(): Edge[] {
  return allTables.flatMap((t) => {
    const cfg = getTableConfig(t);
    return cfg.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        table: cfg.name,
        column: ref.columns.map((c) => c.name).join(","),
        parent: getTableConfig(ref.foreignTable).name,
        onDelete: fk.onDelete ?? "no action",
      };
    });
  });
}

async function rowsOf<T>(q: Promise<unknown>): Promise<T[]> {
  const r = (await q) as { rows?: T[] } & T[];
  return r.rows ?? r;
}

describe("every table is accounted for", () => {
  it("each table is reached by the cascade from users, or kept on purpose with a reason", () => {
    const edges = schemaEdges();
    const owned = new Set(["users"]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges) {
        if (e.onDelete === "cascade" && owned.has(e.parent) && !owned.has(e.table)) {
          owned.add(e.table);
          grew = true;
        }
      }
    }
    const names = allTables.map(nameOf).sort();
    const unclassified = names.filter((n) => !owned.has(n) && !(n in KEPT));
    expect(unclassified, "new table without a decided lifecycle").toEqual([]);
    // No stale entries: a kept table really isn't deleted with the account, and exists.
    expect(Object.keys(KEPT).filter((n) => owned.has(n) || !names.includes(n))).toEqual([]);
    expect(names.length).toBe(owned.size + Object.keys(KEPT).length);
  });

  it("every foreign key cascades, except the reviewed SET NULL ones", () => {
    const edges = schemaEdges();
    const bad = edges
      .filter((e) => e.onDelete !== "cascade")
      .filter((e) => !(e.onDelete === "set null" && `${e.table}.${e.column}` in SET_NULL))
      .map((e) => `${e.table}.${e.column} (${e.onDelete})`);
    expect(bad).toEqual([]);
    const setNull = edges
      .filter((e) => e.onDelete === "set null")
      .map((e) => `${e.table}.${e.column}`)
      .sort();
    expect(setNull).toEqual(Object.keys(SET_NULL).sort());
  });

  it("the migrated database matches the schema: same tables, same delete rules", async () => {
    const tables = await rowsOf<{ name: string }>(
      database.execute(
        sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
      ),
    );
    expect(tables.map((r) => r.name).sort()).toEqual(allTables.map(nameOf).sort());

    const fks = await rowsOf<{ tbl: string; col: string; parent: string; rule: string }>(
      database.execute(sql`
        select c.conrelid::regclass::text as tbl, a.attname as col,
               c.confrelid::regclass::text as parent, c.confdeltype as rule
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace`),
    );
    const rule = { c: "cascade", n: "set null", a: "no action", r: "restrict", d: "set default" };
    const fromDb = fks
      .map((f) => `${f.tbl}.${f.col}->${f.parent}:${rule[f.rule as keyof typeof rule]}`)
      .sort();
    const fromSchema = schemaEdges()
      .map((e) => `${e.table}.${e.column}->${e.parent}:${e.onDelete}`)
      .sort();
    expect(fromDb).toEqual(fromSchema);
  });
});

// --- Seeding ----------------------------------------------------------------------------------

const tokens: string[] = [];
const connector = {
  revoke: async (token: string) => void tokens.push(token),
} as unknown as MailboxConnector;

type Box = { mailboxId: string; threadId: string; messageId: string; draftId: string };

/** A mailbox with one of everything that hangs off it. */
async function seedMailbox(
  workspace: { id: string; plan: "solo" | "crew" | "company" | null },
  email: string,
  tag: string,
): Promise<Box> {
  const mb = await saveConnectedMailbox(workspace, {
    email,
    refreshToken: `rt-${tag}`,
    grantedScopes: ["x"],
  });
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: mb.id,
      gmailThreadId: `gt-${tag}`,
      subject: "Panel upgrade",
      participants: [`dana-${tag}@customer.com`],
      lastMessageAt: daysAgo(1),
      inInbox: true,
      category: "quote_request",
      summary: "Wants a quote for a panel upgrade",
      extracted: { service_requested: "panel upgrade", address: "12 Elm St" },
    })
    .returning();
  const [m] = await database
    .insert(messages)
    .values({
      threadId: t!.id,
      mailboxId: mb.id,
      gmailMessageId: `gm-${tag}`,
      fromAddress: `dana-${tag}@customer.com`,
      fromName: "Dana Smith",
      direction: "in",
      subject: "Panel upgrade",
      snippet: "Can you quote",
      bodyText: "Can you quote a panel upgrade at 12 Elm St?",
      sentAt: daysAgo(1),
    })
    .returning();
  const [d] = await database
    .insert(drafts)
    .values({
      threadId: t!.id,
      mailboxId: mb.id,
      replyToMessageId: m!.id,
      toAddress: `dana-${tag}@customer.com`,
      subject: "Re: Panel upgrade",
      body: "Hi Dana, happy to look Tuesday.",
      originalBody: "Hi Dana, happy to take a look.",
      status: "sent",
      reason: "Customer asked for a quote.",
      decidedAt: daysAgo(1),
    })
    .returning();
  await database.insert(editSignals).values({
    draftId: d!.id,
    workspaceId: workspace.id,
    wordsBefore: 6,
    wordsAfter: 6,
    openingChanged: false,
    signoffChanged: false,
    firstSentenceCut: false,
    sentencesRemoved: 0,
    sentencesAdded: 0,
  });
  await database.insert(priceHistory).values({
    workspaceId: workspace.id,
    threadId: t!.id,
    service: "panel upgrade",
    amountCents: 180_000,
    quotedAt: daysAgo(1),
  });
  await database.insert(activityLog).values({
    workspaceId: workspace.id,
    actor: "owner",
    action: "reply_sent",
    threadId: t!.id,
    detail: { draftId: d!.id, kind: "reply" },
  });
  return { mailboxId: mb.id, threadId: t!.id, messageId: m!.id, draftId: d!.id };
}

/** An owner (invited) with a row in every workspace-level table and two mailboxes. */
async function seedOwner(email: string, tag: string, extra: { referredBy?: string } = {}) {
  await database.insert(invites).values({ email, trade: "electrical" });
  const { user, workspace } = await ensureUserAndWorkspace({ email });
  await database
    .update(workspaces)
    .set({
      plan: "crew",
      stripeSubscriptionId: `sub_${tag}`,
      referredByWorkspaceId: extra.referredBy ?? null,
    })
    .where(eq(workspaces.id, workspace.id));
  const a = await seedMailbox({ id: workspace.id, plan: "crew" }, email, `${tag}-a`);
  const b = await seedMailbox({ id: workspace.id, plan: "crew" }, `office-${email}`, `${tag}-b`);
  const ws = workspace.id;
  await database.insert(businessProfiles).values({
    workspaceId: ws,
    services: "Panels",
    vipSenders: [`vip-${tag}@customer.com`],
  });
  await database.insert(voiceProfiles).values({
    workspaceId: ws,
    status: "ready",
    examples: ["Hi {{name}}, thanks for reaching out."],
  });
  await database.insert(usage).values({ workspaceId: ws, period: "2026-10-12", aiCalls: 3 });
  await database.insert(rules).values({ workspaceId: ws, category: "scheduling" });
  await database
    .insert(seasonalNotes)
    .values({ workspaceId: ws, text: "Booked through November", endsOn: "2026-11-30" });
  await database
    .insert(voiceSuggestions)
    .values({ workspaceId: ws, kind: "shorter", text: "Keep replies shorter" });
  await database
    .insert(pushSubscriptions)
    .values({ workspaceId: ws, endpoint: `https://fcm.googleapis.com/fcm/send/${tag}` });
  // Ideas H3 / G7: sender rules go with the workspace; private notes with the mailbox too.
  await database
    .insert(ownerSenderRules)
    .values({ workspaceId: ws, pattern: `deals@${tag}.com`, scope: "address", action: "junk" });
  await database.insert(customerNotes).values({
    workspaceId: ws,
    mailboxId: a.mailboxId,
    address: `dana@${tag}.com`,
    body: "Gate 4411",
  });
  await database.insert(waitlist).values({ email, name: "Owner", phone: "555-0100" });
  // Squared Away Growth: the client row, its updates and months go with the workspace.
  const [gc] = await database
    .insert(growthClients)
    .values({ workspaceId: ws, startedOn: "2026-10-01", services: ["reviews"] })
    .returning();
  await database
    .insert(growthUpdates)
    .values({ growthClientId: gc!.id, title: "Ads", body: "Live" });
  await database
    .insert(growthMonthly)
    .values({ growthClientId: gc!.id, month: "2026-10", newLeads: 3 });
  await database.insert(appSettings).values([
    { key: `cost_alert:${ws}:2026-10`, value: "1" },
    { key: `email-sent:digest-${ws}-2026-10-12`, value: NOW.toISOString() },
    { key: `email-sent:access-lost-${a.mailboxId}-1-1`, value: NOW.toISOString() },
  ]);
  await database.insert(rateLimits).values({ key: `send:${ws}`, windowStart: NOW, count: 1 });
  await database.insert(stripeEvents).values({ id: `evt_${tag}`, type: "invoice.paid" });
  // Check 25 P1 / P4: Gmail unit minutes (go with the mailbox) and job counts (global).
  await database.insert(gmailUnits).values({ mailboxId: a.mailboxId, minute: NOW, units: 20 });
  await database.insert(jobRuns).values({ functionId: `${tag}-job`, day: "2026-10-12", runs: 1 });
  return { userId: user.id, workspaceId: ws, a, b };
}

type Snapshot = Record<string, string[]>;
async function snapshot(): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const t of allTables) {
    const rows = await database.select().from(t);
    out[nameOf(t)] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

// --- Delete my account ------------------------------------------------------------------------

describe("delete my account", () => {
  it("removes every row the owner's account holds, and nothing of anyone else's", async () => {
    tokens.length = 0;
    const other = await seedOwner("other@builder.com", "other");
    // Global rows must survive too (the other account's own markers come from seedOwner).
    await database.insert(appSettings).values([
      { key: "backfill:m7-v1", value: "done" },
      { key: "stripe_webhook_secret", value: "encrypted" },
    ]);
    const before = await snapshot();

    const owner = await seedOwner("owner@shop.com", "owner", { referredBy: other.workspaceId });
    await database.insert(referralCredits).values({
      referredWorkspaceId: owner.workspaceId,
      beneficiaryWorkspaceId: other.workspaceId,
      referredEmailSha256: "f".repeat(64),
      side: "referrer",
      amountCents: 2_500,
      status: "applied",
    });
    const seeded = await snapshot();
    // One row in EVERY table: a new table fails here until it is seeded above.
    const notSeeded = Object.keys(seeded).filter(
      (n) => seeded[n]!.length <= (before[n]?.length ?? 0),
    );
    expect(notSeeded).toEqual([]);

    const canceled: string[] = [];
    setStripeForTests({
      subscriptions: { cancel: async (id: string) => void canceled.push(id) },
    } as unknown as Stripe);
    const r = await deleteAccount(owner.userId, connector);
    expect(r).toEqual({ mailboxes: 2, revoked: 2, subscriptionCanceled: true });
    expect(tokens.sort()).toEqual(["rt-owner-a", "rt-owner-b"]);
    expect(canceled).toEqual(["sub_owner"]);

    const after = await snapshot();
    const kept = new Set([
      "waitlist",
      "rate_limits",
      "stripe_events",
      "referral_credits",
      "job_runs",
    ]);
    for (const name of Object.keys(after)) {
      if (kept.has(name)) continue;
      // The owner's rows are all gone (invites and the cost-alert / sent-email markers too),
      // and the other account's rows and the global settings are exactly as they were.
      expect(after[name], name).toEqual(before[name]);
    }
    // Kept on purpose (listed for the privacy policy):
    expect(
      await database.select().from(waitlist).where(eq(waitlist.email, "owner@shop.com")),
    ).toHaveLength(1); // may hold a Growth call request; the owner can ask us
    expect(
      await database
        .select()
        .from(rateLimits)
        .where(eq(rateLimits.key, `send:${owner.workspaceId}`)),
    ).toHaveLength(1); // purged within 2 days
    expect(await database.select().from(stripeEvents)).toHaveLength(2);
    const credits = await database.select().from(referralCredits);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.referredWorkspaceId).toBeNull();
    expect(credits[0]!.beneficiaryWorkspaceId).toBe(other.workspaceId);
  });

  it("a deleted owner's waitlist entry offers Invite again, and inviting lets them back in", async () => {
    const owner = await seedOwner("owner@shop.com", "owner");
    // Davi invited them from the waitlist before they signed up.
    await database
      .update(waitlist)
      .set({ invitedAt: daysAgo(20) })
      .where(eq(waitlist.email, "owner@shop.com"));
    const card = async () => (await listWaitlist()).find((w) => w.email === "owner@shop.com")!;
    expect((await card()).inviteState).toBe("invited");

    setStripeForTests({
      subscriptions: { cancel: async () => {} },
    } as unknown as Stripe);
    await deleteAccount(owner.userId, connector);

    // The entry is kept and still remembers the old invite, but the card must not say
    // "Invited": the invite is gone and they can't sign in.
    const after = await card();
    expect(after.invitedAt).not.toBeNull();
    expect(after.inviteState).toBe("invite_gone");
    expect(after.inviteAt).toBeNull();
    expect(await isAllowedToSignIn("owner@shop.com")).toBe(false);

    expect(await inviteFromWaitlist("owner@shop.com", NOW)).toBe("invited");
    const again = await card();
    expect(again.inviteState).toBe("invited");
    expect(again.inviteAt).not.toBeNull();
    expect(await isAllowedToSignIn("owner@shop.com")).toBe(true);
    const [inv] = await database.select().from(invites).where(eq(invites.email, "owner@shop.com"));
    expect(inv?.acceptedAt ?? null).toBeNull();
  });

  it("nothing is deleted if the database part fails halfway (one transaction)", async () => {
    const owner = await seedOwner("owner@shop.com", "owner");
    setStripeForTests({
      subscriptions: { cancel: async () => {} },
    } as unknown as Stripe);
    const before = await snapshot();
    // Make the last statement of the transaction fail.
    await database.execute(sql`
      create function fail_settings_delete() returns trigger language plpgsql as $$
      begin raise exception 'boom'; end $$`);
    await database.execute(sql`
      create trigger fail_settings_delete before delete on app_settings
      for each row execute function fail_settings_delete()`);
    await expect(deleteAccount(owner.userId, connector)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});

// --- Disconnect -------------------------------------------------------------------------------

describe("disconnect a Gmail address", () => {
  it("removes what came from that mailbox, keeps the other mailbox and the workspace's own rows", async () => {
    tokens.length = 0;
    const o = await seedOwner("owner@shop.com", "owner");
    const workspaceLevel = [
      voiceProfiles,
      businessProfiles,
      usage,
      voiceSuggestions,
      seasonalNotes,
      pushSubscriptions,
      rules,
      ownerSenderRules,
    ];
    const counts = async () =>
      Promise.all(workspaceLevel.map(async (t) => (await database.select().from(t)).length));
    const beforeCounts = await counts();
    const activityBefore = (await database.select().from(activityLog)).length;

    expect(await disconnectMailbox(o.workspaceId, o.a.mailboxId, connector)).toBe(true);
    expect(tokens).toEqual(["rt-owner-a"]);

    const ids = <T extends { id?: string; draftId?: string }>(rows: T[]) =>
      rows.map((r) => r.id ?? r.draftId);
    expect(ids(await database.select().from(mailboxes))).toEqual([o.b.mailboxId]);
    expect(ids(await database.select().from(threads))).toEqual([o.b.threadId]);
    expect(ids(await database.select().from(messages))).toEqual([o.b.messageId]);
    expect(ids(await database.select().from(drafts))).toEqual([o.b.draftId]);
    expect(ids(await database.select().from(editSignals))).toEqual([o.b.draftId]);
    expect((await database.select().from(priceHistory)).map((r) => r.threadId)).toEqual([
      o.b.threadId,
    ]);

    // Ideas G7: a private note goes with the Gmail address it was written under.
    expect(await database.select().from(customerNotes)).toEqual([]);
    // Writing style, style suggestions, business details, usage, notes, phones and rules stay.
    expect(await counts()).toEqual(beforeCounts);
    // Activity history stays (plus the disconnect itself), even where its thread is gone.
    const activity = await database.select().from(activityLog);
    expect(activity).toHaveLength(activityBefore + 1);
    expect(activity.some((r) => r.threadId === o.a.threadId)).toBe(true);
    const listed = await listActivity(o.workspaceId);
    expect(listed.map((e) => e.text)).toContain("You sent a reply");
    expect(listed.map((e) => e.text)).toContain("You sent a reply to Dana");
  });
});

// --- Retention purge --------------------------------------------------------------------------

describe("retention purge (30 days)", () => {
  const fullFacts = {
    service_requested: "panel upgrade",
    address: "12 Elm St, Westford",
    dates: ["Tuesday at 9"],
    dollar_amounts: [1800],
    urgency: "normal",
    permit: {
      issuing_body: "Town of Westford Building Dept.",
      permit_number: "B-2026-118",
      inspection_at: "2026-08-20T09:00:00",
      result: "failed",
      corrections: ["Add a GFCI in the kitchen"],
    },
    invoice: { invoice_number: "1043", amount: 1800, due_date: "2026-09-01", status: "unpaid" },
    accepts_quote: true,
    quote_accepted: true,
    quote_accepted_at: "2026-08-10T15:00:00.000Z",
    job_done: true,
    injection: true,
    municipal: true,
    invoice_thread: true,
    disputed: true,
    payment_said: "partly_paid",
  };
  // What's left after the purge: no street address, dates or correction notes.
  const purgedFacts: Record<string, unknown> = structuredClone(fullFacts);
  delete purgedFacts.address;
  delete purgedFacts.dates;
  delete (purgedFacts.permit as Record<string, unknown>).corrections;

  async function seed() {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const mb = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: ["x"],
    });
    const thread = async (tag: string, at: Date, extracted: Record<string, unknown> | null) => {
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId: mb.id,
          gmailThreadId: tag,
          lastMessageAt: at,
          inInbox: true,
          category: "invoice_payment",
          extracted,
        })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: mb.id,
        gmailMessageId: `m-${tag}`,
        fromAddress: "dana@customer.com",
        fromName: "Dana",
        direction: "in",
        subject: "Invoice 1043",
        snippet: "Here's the invoice",
        bodyText: "Invoice 1043 for $1,800, 12 Elm St.",
        sentAt: at,
      });
      return t!.id;
    };
    const oldT = await thread("old", daysAgo(40), fullFacts);
    const newT = await thread("new", daysAgo(2), fullFacts);
    const nullPermit = await thread("null-permit", daysAgo(40), {
      address: "3 Oak Rd",
      dates: [],
      permit: null,
    });
    const noFacts = await thread("no-facts", daysAgo(40), null);

    const draft = async (threadId: string, created: Date, status: "pending" | "sent") => {
      const [d] = await database
        .insert(drafts)
        .values({
          threadId,
          mailboxId: mb.id,
          toAddress: "dana@customer.com",
          subject: "Re: Invoice 1043",
          body: "Hi Dana, the $1,800 is due Friday.",
          originalBody: "Hi Dana, the $1,800 is due.",
          status,
          reason: "Customer asked about the invoice.",
          flags: ["Mentions $1,800 — check it.", "Says “guaranteed” — make sure."],
          createdAt: created,
          ...(status === "pending"
            ? { sendAfter: daysAgo(31), sendClaimedAt: daysAgo(31), autoSendAt: daysAgo(31) }
            : { decidedAt: created }),
        })
        .returning();
      return d!.id;
    };
    const oldPending = await draft(oldT, daysAgo(35), "pending");
    const oldSent = await draft(nullPermit, daysAgo(35), "sent");
    const recentPending = await draft(newT, daysAgo(2), "pending");
    // How older code left a purged draft: text gone, flags (which quote it) still there.
    const prePurged = await draft(noFacts, daysAgo(35), "sent");
    await database
      .update(drafts)
      .set({ body: null, originalBody: null })
      .where(eq(drafts.id, prePurged));
    await database.insert(priceHistory).values({
      workspaceId: workspace.id,
      threadId: oldT,
      service: "panel upgrade",
      amountCents: 180_000,
      quotedAt: daysAgo(40),
    });
    return {
      workspaceId: workspace.id,
      oldT,
      newT,
      nullPermit,
      noFacts,
      oldPending,
      oldSent,
      recentPending,
      prePurged,
    };
  }

  it("removes email text everywhere it was copied, keeps the facts the app still uses", async () => {
    const s = await seed();
    expect(await purgeExpiredBodies(NOW, 30)).toBe(3);

    const msgs = await database.select().from(messages);
    const byThread = new Map(msgs.map((m) => [m.threadId, m]));
    for (const t of [s.oldT, s.nullPermit, s.noFacts]) {
      expect(byThread.get(t)!.bodyText).toBeNull();
      expect(byThread.get(t)!.snippet).toBeNull();
      expect(byThread.get(t)!.subject).toBe("Invoice 1043"); // metadata stays
    }
    expect(byThread.get(s.newT)!.bodyText).not.toBeNull();

    const ds = new Map((await database.select().from(drafts)).map((d) => [d.id, d]));
    const op = ds.get(s.oldPending)!;
    expect(op).toMatchObject({
      status: "expired",
      body: null,
      originalBody: null,
      flags: [],
      sendAfter: null,
      sendClaimedAt: null,
      autoSendAt: null,
    });
    expect(op.decidedAt).toEqual(NOW);
    expect(ds.get(s.oldSent)).toMatchObject({
      status: "sent",
      body: null,
      originalBody: null,
      flags: [],
    });
    expect(ds.get(s.prePurged)).toMatchObject({ body: null, originalBody: null, flags: [] });
    const rp = ds.get(s.recentPending)!;
    expect(rp.status).toBe("pending");
    expect(rp.body).not.toBeNull();
    expect(rp.flags).toHaveLength(2);
    expect(rp.sendAfter).not.toBeNull();

    const ts = new Map((await database.select().from(threads)).map((t) => [t.id, t]));
    expect(ts.get(s.oldT)!.extracted).toEqual(purgedFacts);
    expect(ts.get(s.nullPermit)!.extracted).toEqual({ permit: null });
    expect(ts.get(s.noFacts)!.extracted).toBeNull();
    expect(ts.get(s.newT)!.extracted).toEqual(fullFacts);

    // Price memory outlives the purge, and Money still shows the old invoice.
    expect(await database.select().from(priceHistory)).toHaveLength(1);
    const money = await listMoney(s.workspaceId, NOW);
    expect(money.owed.find((r) => r.threadId === s.oldT)).toMatchObject({
      invoiceNumber: "1043",
      amountCents: 180_000,
    });

    // A second run finds nothing left to do.
    const once = await snapshot();
    expect(await purgeExpiredBodies(NOW, 30)).toBe(0);
    expect(await snapshot()).toEqual(once);
  });

  it("leaves recent conversations' facts alone even when an old draft is on them", async () => {
    const s = await seed();
    await database
      .update(drafts)
      .set({ createdAt: daysAgo(35) })
      .where(inArray(drafts.id, [s.recentPending]));
    await purgeExpiredBodies(NOW, 30);
    const [t] = await database.select().from(threads).where(eq(threads.id, s.newT));
    expect(t!.extracted).toEqual(fullFacts);
  });
});
