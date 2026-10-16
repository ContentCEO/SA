import "server-only";
import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import { looksMunicipal } from "@/ai/guards";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  messages,
  ownerSenderRules,
  threads,
  workspaces,
  type OwnerSenderRuleAction,
  type OwnerSenderRuleScope,
} from "@/db/schema";
import { jobsAllowed, ReadOnlyError, effectiveStatus } from "./lifecycle";
import {
  companyChoice,
  domainOf,
  keyFromMessage,
  matchRules,
  MAX_SENDER_RULES,
  normalizePattern,
  type RuleRefusal,
  type SenderRule,
} from "./owner-sender-rule-rules";
import { customerReplyAddress } from "./reply-address-rules";
import { workspaceMailboxEmails } from "./reply-address";
import { notDraftSql, replyAddressSql } from "./thread-sql";

/**
 * Ideas H3: the owner's sender rules. Never sent to the AI; only this file, classification and
 * drafting read them. Activity rows carry the action and scope only, never the address.
 */
export async function rulesForWorkspace(workspaceId: string): Promise<SenderRule[]> {
  return db()
    .select({
      pattern: ownerSenderRules.pattern,
      scope: ownerSenderRules.scope,
      action: ownerSenderRules.action,
    })
    .from(ownerSenderRules)
    .where(eq(ownerSenderRules.workspaceId, workspaceId));
}

export async function listRules(workspaceId: string) {
  return db()
    .select({
      id: ownerSenderRules.id,
      pattern: ownerSenderRules.pattern,
      scope: ownerSenderRules.scope,
      action: ownerSenderRules.action,
    })
    .from(ownerSenderRules)
    .where(eq(ownerSenderRules.workspaceId, workspaceId))
    .orderBy(asc(ownerSenderRules.pattern));
}

/** The source email of a rule (an inbound message of this workspace), by its id. */
export async function ruleSource(workspaceId: string, messageId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) return null;
  const [m] = await db()
    .select({
      id: messages.id,
      mailboxId: messages.mailboxId,
      fromAddress: messages.fromAddress,
      fromName: messages.fromName,
      replyToHeader: messages.replyToHeader,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
      ),
    );
  return m ?? null;
}

/** An address (or anyone at a domain) the owner may not hide: they write to them, or money/quotes are open. */
async function mustReach(
  workspaceId: string,
  pattern: string,
  scope: OwnerSenderRuleScope,
): Promise<boolean> {
  const p = normalizePattern(pattern);
  const matchAddr = (expr: SQL) =>
    scope === "address"
      ? sql`${expr} = ${p}`
      : sql`(regexp_replace(${expr}, '^.*@', '') = ${p} or regexp_replace(${expr}, '^.*@', '') like ${`%.${p}`})`;
  // The owner wrote to them (their own sent mail, not an unsent draft).
  const wrote = await db()
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "out"),
        sql`${notDraftSql("messages")}`,
        sql`exists (select 1 from jsonb_array_elements_text(${messages.toAddresses} || ${messages.ccAddresses}) as r(a) where ${matchAddr(sql`lower(trim(r.a))`)})`,
      ),
    )
    .limit(1);
  if (wrote.length) return true;
  // An open quote (no outcome) or an invoice still owed, from them.
  const open = await db()
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        sql`((${threads.category} = 'quote_request' and ${threads.quoteOutcome} is null)
          or ((jsonb_typeof(${threads.extracted}->'invoice') = 'object' or ${threads.extracted}->>'invoice_thread' = 'true')
            and ${threads.invoicePaidAt} is null
            and (${threads.extracted}->>'bill_direction') is distinct from 'owed_by_business'))`,
        sql`exists (select 1 from messages m where m.thread_id = ${threads.id} and m.direction = 'in' and ${matchAddr(replyAddressSql("m"))})`,
      ),
    )
    .limit(1);
  return open.length > 0;
}

export type SaveRuleResult =
  | { status: "saved"; action: OwnerSenderRuleAction; scope: OwnerSenderRuleScope }
  | { status: "vip" }
  | { status: "refused"; why: RuleRefusal };

/**
 * Save a rule from one email the owner is looking at. Every guard is checked here, whatever
 * the sheet showed. "Always needs me" for one address adds it to the VIP list instead.
 */
export async function saveRule(
  workspaceId: string,
  input: { messageId: string; action: OwnerSenderRuleAction; scope: OwnerSenderRuleScope },
  now: Date = new Date(),
): Promise<SaveRuleResult> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) return { status: "refused", why: "not_found" };
  if (!jobsAllowed(ws, now)) throw new ReadOnlyError(effectiveStatus(ws, now));
  const m = await ruleSource(workspaceId, input.messageId);
  if (!m) return { status: "refused", why: "not_found" };
  const key = keyFromMessage(m);
  if (!key.ok) return { status: "refused", why: key.why };
  let pattern = key.key;
  if (input.scope === "domain") {
    const d = companyChoice(key.key, await workspaceMailboxEmails(workspaceId));
    if (!d) return { status: "refused", why: "webmail_company" };
    pattern = d;
  }
  if (input.action === "needs_me" && input.scope === "address") {
    await addVip(workspaceId, key.key, "rule_sheet");
    return { status: "vip" };
  }
  if (input.action === "junk") {
    if (looksMunicipal(m.fromAddress, m.fromName)) return { status: "refused", why: "municipal" };
    const [p] = await db()
      .select({ vips: businessProfiles.vipSenders })
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    const vips = (p?.vips ?? []).map(normalizePattern);
    const vipHit =
      input.scope === "address"
        ? vips.includes(pattern)
        : vips.some((v) => domainOf(v) === pattern || (domainOf(v) ?? "").endsWith(`.${pattern}`));
    if (vipHit || (await mustReach(workspaceId, pattern, input.scope)))
      return { status: "refused", why: "known_customer" };
  }
  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(ownerSenderRules)
    .where(eq(ownerSenderRules.workspaceId, workspaceId));
  const [existing] = await db()
    .select({ id: ownerSenderRules.id })
    .from(ownerSenderRules)
    .where(
      and(eq(ownerSenderRules.workspaceId, workspaceId), eq(ownerSenderRules.pattern, pattern)),
    );
  if (!existing && n >= MAX_SENDER_RULES) return { status: "refused", why: "full" };
  await db()
    .insert(ownerSenderRules)
    .values({ workspaceId, pattern, scope: input.scope, action: input.action, createdAt: now })
    .onConflictDoUpdate({
      target: [ownerSenderRules.workspaceId, ownerSenderRules.pattern],
      set: { scope: input.scope, action: input.action },
    });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "sender_rule_added",
      detail: { action: input.action, scope: input.scope },
    });
  return { status: "saved", action: input.action, scope: input.scope };
}

export async function removeRule(workspaceId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const gone = await db()
    .delete(ownerSenderRules)
    .where(and(eq(ownerSenderRules.id, id), eq(ownerSenderRules.workspaceId, workspaceId)))
    .returning({ action: ownerSenderRules.action, scope: ownerSenderRules.scope });
  if (!gone.length) return false;
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "sender_rule_removed",
      detail: { action: gone[0]!.action, scope: gone[0]!.scope },
    });
  return true;
}

/**
 * Add one address to the VIP list (the same rule as the profile form: an email, lowercased,
 * at most 50). Idempotent. Returns false when the list is full.
 */
export async function addVip(
  workspaceId: string,
  address: string,
  via: "rule_sheet",
): Promise<boolean> {
  const a = normalizePattern(address);
  await db().insert(businessProfiles).values({ workspaceId }).onConflictDoNothing();
  const rows = await db()
    .update(businessProfiles)
    .set({
      vipSenders: sql`case when ${businessProfiles.vipSenders} ? ${a} then ${businessProfiles.vipSenders} else ${businessProfiles.vipSenders} || jsonb_build_array(${a}::text) end`,
    })
    .where(
      and(
        eq(businessProfiles.workspaceId, workspaceId),
        sql`(${businessProfiles.vipSenders} ? ${a} or jsonb_array_length(${businessProfiles.vipSenders}) < 50)`,
      ),
    )
    .returning({ id: businessProfiles.workspaceId });
  if (!rows.length) return false;
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "vip_added", detail: { via } });
  return true;
}

/**
 * Live, for drafting: does a "Never draft" rule cover this email's sender or reply address?
 * Live so a rule made today stops tomorrow's nudge on an older conversation.
 */
export async function noDraftRuleFor(
  workspaceId: string,
  m: {
    fromAddress: string | null;
    replyToHeader: Parameters<typeof customerReplyAddress>[0]["replyToHeader"];
  },
): Promise<boolean> {
  const rules = await rulesForWorkspace(workspaceId);
  if (!rules.length) return false;
  return matchRules(rules, {
    from: m.fromAddress,
    replyAddress: customerReplyAddress(m),
    replyToHeader: m.replyToHeader,
    vips: [],
  }).noDraft;
}
