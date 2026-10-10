import "server-only";
import { and, count, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, pushSubscriptions, workspaces } from "@/db/schema";
import { pushConfigured, sendPush, type PushSender } from "@/lib/web-push";
import { jobsAllowed } from "./lifecycle";
import { freshLeads, inQuietHours, leadCounts, SMS } from "./sms-alerts";

/**
 * Plan #36: a phone notification when new quote requests or emails that need
 * the owner arrive. Same rules as texts: quiet 9pm–7am, at least 10 minutes
 * apart, at most 10 a day, only fresh mail. The push itself is empty; the
 * phone fetches the counts (pushSummary) to show.
 */

/** Push services we deliver to. Anything else is refused at subscribe time. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

export async function savePushSubscription(workspaceId: string, endpoint: string) {
  if (!isPushEndpoint(endpoint)) return false;
  await db()
    .insert(pushSubscriptions)
    .values({ workspaceId, endpoint })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { workspaceId } });
  return true;
}

/** What the phone shows when a push arrives: counts only, never names or words. */
export function pushSummaryText(c: { replies: number; needsYou: number }): string {
  const parts = [
    c.needsYou
      ? `${c.needsYou} email${c.needsYou === 1 ? "" : "s"} need${c.needsYou === 1 ? "s" : ""} you`
      : null,
    c.replies ? `${c.replies} repl${c.replies === 1 ? "y" : "ies"} ready to send` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Your queue is up to date.";
}

export async function removePushSubscription(workspaceId: string, endpoint: string) {
  await db()
    .delete(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.workspaceId, workspaceId), eq(pushSubscriptions.endpoint, endpoint)),
    );
}

export async function sendPushAlerts(
  now: Date = new Date(),
  deps: { push?: PushSender; workspaceId?: string } = {},
) {
  const push = deps.push ?? sendPush;
  if (!deps.push && !pushConfigured()) return { sent: 0, notConfigured: true };
  const subs = await db()
    .select()
    .from(pushSubscriptions)
    .where(deps.workspaceId ? eq(pushSubscriptions.workspaceId, deps.workspaceId) : undefined);
  const byWorkspace = new Map<string, string[]>();
  for (const s of subs)
    byWorkspace.set(s.workspaceId, [...(byWorkspace.get(s.workspaceId) ?? []), s.endpoint]);
  if (!byWorkspace.size) return { sent: 0 };

  const rows = await db()
    .select({ workspace: workspaces, profile: businessProfiles })
    .from(workspaces)
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(inArray(workspaces.id, [...byWorkspace.keys()]));

  let sent = 0;
  for (const { workspace: w, profile: p } of rows) {
    if (!jobsAllowed(w, now)) continue;
    if (inQuietHours(now, p?.timeZone ?? "America/New_York")) continue;
    const last = p?.pushLastSentAt;
    if (last && now.getTime() - last.getTime() < SMS.minGapMs) continue;
    const [today] = await db()
      .select({ n: count() })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.workspaceId, w.id),
          eq(activityLog.action, "push_alert_sent"),
          gte(activityLog.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        ),
      );
    if ((today?.n ?? 0) >= SMS.dailyCap) continue;

    const fresh = await freshLeads(w.id, p?.pushAlertCursor ?? null, now);
    if (!fresh.length) continue;

    // Claim the slot first so two runs can't both buzz the phone.
    const set = { pushLastSentAt: now, pushAlertCursor: fresh[0]!.classifiedAt! };
    const claimed = await db()
      .insert(businessProfiles)
      .values({ workspaceId: w.id, ...set })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set,
        setWhere: or(
          isNull(businessProfiles.pushLastSentAt),
          lt(businessProfiles.pushLastSentAt, new Date(now.getTime() - SMS.minGapMs)),
        ),
      })
      .returning({ id: businessProfiles.workspaceId });
    if (!claimed.length) continue;

    let delivered = 0;
    for (const endpoint of byWorkspace.get(w.id) ?? []) {
      const r = await push(endpoint);
      if (r === "gone") await removePushSubscription(w.id, endpoint);
      if (r === "sent") delivered++;
    }
    await db()
      .insert(activityLog)
      .values({
        workspaceId: w.id,
        actor: "squared_away",
        action: "push_alert_sent",
        detail: { ...leadCounts(fresh), phones: delivered },
        createdAt: now,
      });
    sent++;
  }
  return { sent };
}
