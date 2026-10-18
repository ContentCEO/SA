import { and, count, eq, lt, sql, type SQLWrapper } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { mailboxes, messages } from "@/db/schema";
import { lastDigestQuery, lastSortedQuery } from "@/server/admin";
import { messageReplyAddress } from "@/server/thread-sql";
import { createTestDb } from "../support/db";

/**
 * Check 29 P6 + Check 30 P4: the hot lookups use their indexes. A few thousand invented rows
 * over five shops, ANALYZEd, then EXPLAIN on the same SQL the code runs (built with the same
 * helpers, so a change to the reply-address expression that stops matching the index fails
 * here).
 */

const SHOPS = 5;
const THREADS_PER_SHOP = 600;
const MESSAGES_PER_THREAD = 4;

let database: Database;
let workspaceIds: string[] = [];
let mailboxId = "";
let threadId = "";

async function plan(query: SQLWrapper): Promise<string> {
  const res = (await database.execute(sql`explain ${query}`)) as unknown as {
    rows: { "QUERY PLAN": string }[];
  };
  return res.rows.map((r) => r["QUERY PLAN"]).join("\n");
}

beforeAll(async () => {
  database = await createTestDb();
  await database.execute(sql`
    insert into users (email) select 'owner' || g || '@shop' || g || '.com' from generate_series(1, ${SHOPS}) g
  `);
  await database.execute(sql`
    insert into workspaces (owner_user_id, business_name) select id, 'Shop' from users
  `);
  await database.execute(sql`
    insert into mailboxes (workspace_id, email, encrypted_refresh_token, scopes)
    select id, id::text || '@shop.com', 'x', 'x' from workspaces
  `);
  await database.execute(sql`
    insert into threads (mailbox_id, gmail_thread_id, classified_at, in_inbox)
    select m.id, m.id::text || '-' || g, now() - (g || ' minutes')::interval, true
    from mailboxes m, generate_series(1, ${THREADS_PER_SHOP}) g
  `);
  await database.execute(sql`
    insert into messages (thread_id, mailbox_id, gmail_message_id, from_address, reply_to_header, direction, sent_at)
    select t.id, t.mailbox_id, t.gmail_thread_id || '-' || g,
           'customer' || (abs(hashtext(t.gmail_thread_id)) % 400) || '@example.com',
           case when g = 1 then '{"address": "Form.Lead@Example.com"}'::jsonb else '{}'::jsonb end,
           (case when g % 2 = 0 then 'out' else 'in' end)::direction,
           now() - (g || ' hours')::interval
    from threads t, generate_series(1, ${MESSAGES_PER_THREAD}) g
  `);
  await database.execute(sql`
    insert into drafts (thread_id, mailbox_id, to_address, subject, reason, status)
    select t.id, t.mailbox_id, 'a@example.com', 's', 'r', 'sent' from threads t
  `);
  await database.execute(sql`
    insert into activity_log (workspace_id, actor, action, created_at)
    select w.id, 'squared_away',
           case when g % 50 = 0 then 'digest_sent' else 'reply_sent' end,
           now() - (g || ' minutes')::interval
    from workspaces w, generate_series(1, 2000) g
  `);
  await database.execute(sql`analyze`);
  const ws = (await database.execute(sql`select id from workspaces order by id`)) as unknown as {
    rows: { id: string }[];
  };
  workspaceIds = ws.rows.map((r) => r.id);
  const t = (await database.execute(
    sql`select id, mailbox_id from threads order by gmail_thread_id limit 1`,
  )) as unknown as { rows: { id: string; mailbox_id: string }[] };
  threadId = t.rows[0]!.id;
  mailboxId = t.rows[0]!.mailbox_id;
});

describe("query plans use the new indexes", () => {
  it("threadsToAutoDraft's newest-draft subquery", async () => {
    const p = await plan(
      sql`select max(d.created_at) from drafts d where d.thread_id = ${threadId}::uuid`,
    );
    expect(p).toContain("drafts_thread_created_idx");
  });

  it("classification's first-time-sender count", async () => {
    // The same query classifyPending runs (classification.ts, "prior").
    const q = database
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          eq(messages.fromAddress, "customer7@example.com"),
          lt(messages.sentAt, sql`now()`),
        ),
      );
    expect(await plan(q)).toContain("messages_mailbox_from_sent_idx");
  });

  it("a customer's conversations by reply address (customerDetail)", async () => {
    const workspaceId = workspaceIds[0]!;
    // The same shape as customerDetail's first query.
    const q = database
      .selectDistinct({ id: messages.threadId })
      .from(messages)
      .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .where(
        and(
          eq(mailboxes.workspaceId, workspaceId),
          eq(messages.direction, "in"),
          sql`${messageReplyAddress()} = ${"form.lead@example.com"}`,
        ),
      );
    expect(await plan(q)).toContain("messages_mailbox_reply_address_idx");
  });

  it("/admin's last sorted", async () => {
    expect(await plan(lastSortedQuery(workspaceIds))).toContain("threads_mailbox_classified_idx");
  });

  it("/admin's last morning email", async () => {
    expect(await plan(lastDigestQuery(workspaceIds))).toContain("activity_digest_sent_idx");
  });

  it("the admin queries still return each shop's newest time", async () => {
    const sorted = await lastSortedQuery(workspaceIds);
    expect(sorted).toHaveLength(SHOPS);
    for (const r of sorted) expect(r.at).toBeInstanceOf(Date);
    const digests = await lastDigestQuery(workspaceIds);
    expect(digests).toHaveLength(SHOPS);
    for (const r of digests) expect(r.at).toBeInstanceOf(Date);
    const empty = await lastDigestQuery([workspaceIds[0]!]);
    expect(empty[0]!.at).toBeInstanceOf(Date);
  });
});
