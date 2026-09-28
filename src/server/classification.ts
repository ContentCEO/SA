import "server-only";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { classifyEmail, type Classification } from "@/ai/classify";
import { AiCapReachedError } from "@/ai/usage";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  mailboxes,
  messages,
  threads,
  workspaces,
} from "@/db/schema";

/** Classify inbound mail from this far back on the first pass; everything new after that. */
export const CLASSIFY_LOOKBACK_DAYS = 14;
/** Until the business profile (Milestone 4) sets it, flag emails that mention more than this. */
export const DEFAULT_AMOUNT_THRESHOLD_DOLLARS = 2_500;
/** Gmail tabs that are never a customer. Skipping the model call here saves real money. */
const NOISE_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"];

export type ClassifyRunResult = {
  classified: number;
  superseded: number;
  remaining: number;
  capped: boolean;
};

const NOISE: Omit<Classification, "summary"> = {
  category: "noise",
  priority: "low",
  needsOwner: false,
  needsOwnerReason: null,
  confidence: 1,
  extracted: {
    service_requested: null,
    address: null,
    dates: [],
    dollar_amounts: [],
    urgency: "low",
  },
  unreadable: false,
};

async function pendingFor(mailboxId: string, since: Date) {
  return db()
    .select({
      id: messages.id,
      threadId: messages.threadId,
      fromAddress: messages.fromAddress,
      fromName: messages.fromName,
      subject: messages.subject,
      bodyText: messages.bodyText,
      snippet: messages.snippet,
      labelIds: messages.labelIds,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "in"),
        isNull(messages.classifiedAt),
        gte(messages.sentAt, since),
        eq(threads.inInbox, true),
      ),
    )
    .orderBy(desc(messages.sentAt));
}

/**
 * Classify what's waiting for one mailbox, newest first. Only the newest
 * unclassified inbound message per thread goes to the model — older ones in
 * the same thread are marked superseded, since the thread's state is what the
 * owner acts on. Idempotent: every handled message gets `classified_at`.
 */
export async function classifyPending(
  mailboxId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<ClassifyRunResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 10;
  const [box] = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  if (!box || box.mailbox.status !== "active")
    return { classified: 0, superseded: 0, remaining: 0, capped: false };

  const since = new Date(now.getTime() - CLASSIFY_LOOKBACK_DAYS * 86_400_000);
  const pending = await pendingFor(mailboxId, since);

  const newestPerThread = new Map<string, (typeof pending)[number]>();
  const superseded: string[] = [];
  for (const m of pending) {
    if (newestPerThread.has(m.threadId)) superseded.push(m.id);
    else newestPerThread.set(m.threadId, m);
  }
  if (superseded.length) {
    await db().update(messages).set({ classifiedAt: now }).where(inArray(messages.id, superseded));
  }

  const [profile] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, box.workspace.id));
  const business = {
    businessName: box.workspace.businessName,
    trade: box.workspace.trade,
    amountThresholdDollars: profile?.amountThresholdDollars ?? DEFAULT_AMOUNT_THRESHOLD_DOLLARS,
    vipSenders: (profile?.vipSenders ?? []).map((v) => v.toLowerCase()),
  };

  const batch = [...newestPerThread.values()].slice(0, limit);
  let classified = 0;
  let capped = false;
  for (const m of batch) {
    let result: Classification;
    if (m.labelIds.some((l) => NOISE_LABELS.includes(l))) {
      result = {
        ...NOISE,
        summary: m.subject ? `Promotional email: ${m.subject}` : "Promotional email.",
      };
    } else {
      const [prior] = await db()
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, mailboxId),
            eq(messages.fromAddress, m.fromAddress ?? ""),
            lt(messages.sentAt, m.sentAt),
          ),
        );
      const [thread] = await db()
        .select({ summary: threads.summary })
        .from(threads)
        .where(eq(threads.id, m.threadId));
      try {
        result = await classifyEmail(
          box.workspace.id,
          business,
          {
            fromName: m.fromName,
            fromAddress: m.fromAddress,
            subject: m.subject,
            receivedAt: m.sentAt,
            firstTimeSender: (prior?.n ?? 0) === 0,
            threadSummary: thread?.summary ?? null,
            body: m.bodyText ?? m.snippet ?? "",
          },
          { senderIsVip: business.vipSenders.includes((m.fromAddress ?? "").toLowerCase()), now },
        );
      } catch (err) {
        if (err instanceof AiCapReachedError) {
          capped = true;
          break;
        }
        throw err;
      }
    }

    await db()
      .update(threads)
      .set({
        category: result.category,
        priority: result.priority,
        // The owner's own "This one needs me" always wins.
        needsOwner: sql`${threads.needsOwnerManual} or ${result.needsOwner}`,
        needsOwnerReason: sql`case when ${threads.needsOwnerManual} then ${threads.needsOwnerReason} else ${result.needsOwnerReason} end`,
        summary: result.summary,
        extracted: result.extracted,
        classifiedAt: now,
      })
      .where(eq(threads.id, m.threadId));
    await db().update(messages).set({ classifiedAt: now }).where(eq(messages.id, m.id));
    classified++;
  }

  const remaining = Math.max(0, newestPerThread.size - classified);
  return { classified, superseded: superseded.length, remaining: capped ? 0 : remaining, capped };
}

/** Inbox action: the owner says a thread needs them. Scoped to their workspace. */
export async function markNeedsOwner(workspaceId: string, threadId: string): Promise<boolean> {
  const owned = await db()
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (owned.length === 0) return false;
  await db()
    .update(threads)
    .set({ needsOwner: true, needsOwnerManual: true, needsOwnerReason: "You marked this one." })
    .where(eq(threads.id, threadId));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "marked_needs_owner",
    threadId,
    detail: {},
  });
  return true;
}
