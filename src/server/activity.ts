import "server-only";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { categoryTag, isCategory } from "@/config/categories";
import { db } from "@/db";
import { activityLog, drafts, mailboxes, messages, threads } from "@/db/schema";

/**
 * The time-saved estimate, and the only assumption behind it. Shown next to
 * the number so the owner can judge it for themselves.
 */
export const MINUTES_PER_SENT_REPLY = 3;

type Who = { name: string | null; category: string | null };

/**
 * One activity row in plain words. The log itself is content-free; the
 * customer's name comes from the owner's own synced mail, shown only to them.
 * Returns null for entries the owner doesn't need to see.
 */
export function describeActivity(
  action: string,
  detail: Record<string, unknown>,
  who: Who | null,
): string | null {
  const name = who?.name?.split(/[\s,]+/)[0] || null;
  const to = name ? ` to ${name}` : "";
  const about = who?.category && isCategory(who.category) ? ` · ${categoryTag[who.category]}` : "";
  switch (action) {
    case "draft_created":
      return `Drafted a reply${to}${about}`;
    case "followup_drafted":
      return `Drafted a follow-up${to}${detail.nudgeNumber === 2 ? " (the last one)" : ""}${about}`;
    case "reply_sent":
      return `You sent ${detail.kind === "followup" ? "a follow-up" : "a reply"}${to}${
        detail.editedByOwner ? ", after editing it" : ""
      }`;
    case "reply_sent_from_gmail":
      return `You sent the draft${to} from Gmail`;
    case "draft_discarded":
      return `You discarded the draft${to}`;
    case "draft_expired":
      return `Withdrew an out-of-date draft${to}`;
    case "marked_needs_owner":
      return `You marked a conversation${name ? ` with ${name}` : ""} as needing you`;
    case "mailbox_connected":
      return "You connected Gmail";
    case "mailbox_reconnected":
      return "You reconnected Gmail";
    case "mailbox_disconnected":
      return "You disconnected Gmail";
    case "mailbox_access_lost":
      return "Lost access to Gmail — reconnect to carry on";
    case "voice_learned":
      return "Learned how you write from your sent mail";
    case "voice_profile_edited":
      return "You edited how you write";
    case "business_profile_saved":
      return "You updated your business profile";
    case "followup_settings_saved":
      return detail.enabled
        ? `Follow-ups on, after ${detail.days} days`
        : "You turned follow-ups off";
    case "digest_settings_saved":
      return detail.enabled
        ? "You changed your morning summary"
        : "You turned the morning summary off";
    case "digest_sent":
      return "Sent your morning summary";
    case "evaluation_started":
      return "Your three days started";
    case "evaluation_expired":
      return "Your three days ended";
    case "workspace_status_changed":
      return detail.to === "setup_paid"
        ? "Setup paid — sending switched on"
        : detail.to === "active"
          ? "Setup finished — your account is active"
          : detail.to === "paused"
            ? "Your account was paused"
            : detail.to === "evaluating"
              ? "Your three days were extended"
              : "Your account status changed";
    default:
      return null;
  }
}

export type ActivityEntry = { id: string; at: Date; text: string; byYou: boolean };

export async function listActivity(workspaceId: string, limit = 100): Promise<ActivityEntry[]> {
  const rows = await db()
    .select()
    .from(activityLog)
    .where(eq(activityLog.workspaceId, workspaceId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);

  const threadIds = [...new Set(rows.map((r) => r.threadId).filter((t): t is string => !!t))];
  const who = new Map<string, Who>();
  if (threadIds.length) {
    const cats = await db()
      .select({ id: threads.id, category: threads.category })
      .from(threads)
      .where(inArray(threads.id, threadIds));
    const names = await db()
      .select({ threadId: messages.threadId, name: messages.fromName })
      .from(messages)
      .where(and(inArray(messages.threadId, threadIds), eq(messages.direction, "in")))
      .orderBy(desc(messages.sentAt));
    for (const c of cats) who.set(c.id, { name: null, category: c.category });
    for (const n of names) {
      const w = who.get(n.threadId);
      if (w && !w.name) w.name = n.name;
    }
  }

  return rows.flatMap((r) => {
    const text = describeActivity(
      r.action,
      r.detail,
      r.threadId ? (who.get(r.threadId) ?? null) : null,
    );
    return text ? [{ id: r.id, at: r.createdAt, text, byYou: r.actor === "owner" }] : [];
  });
}

export type MonthSummary = {
  sorted: number;
  drafted: number;
  sent: number;
  sentAfterEditing: number;
  nudgesSent: number;
  minutesSaved: number;
};

/** This calendar month (UTC), in counts. */
export async function monthSummary(
  workspaceId: string,
  now: Date = new Date(),
): Promise<MonthSummary> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const boxes = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (boxes.length === 0)
    return { sorted: 0, drafted: 0, sent: 0, sentAfterEditing: 0, nudgesSent: 0, minutesSaved: 0 };

  const [sorted] = await db()
    .select({ n: count() })
    .from(threads)
    .where(and(inArray(threads.mailboxId, boxes), gte(threads.classifiedAt, start)));
  const made = await db()
    .select({ status: drafts.status, kind: drafts.kind, decidedAt: drafts.decidedAt })
    .from(drafts)
    .where(and(inArray(drafts.mailboxId, boxes), gte(drafts.createdAt, start)));
  const sentRows = made.filter((d) => d.status === "sent" || d.status === "edited_and_sent");
  const sent = sentRows.length;
  return {
    sorted: sorted?.n ?? 0,
    drafted: made.length,
    sent,
    sentAfterEditing: sentRows.filter((d) => d.status === "edited_and_sent").length,
    nudgesSent: sentRows.filter((d) => d.kind === "followup").length,
    minutesSaved: sent * MINUTES_PER_SENT_REPLY,
  };
}
