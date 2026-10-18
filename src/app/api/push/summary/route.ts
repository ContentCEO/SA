import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { badgeCountOf } from "@/server/badge";
import { headerPicks, toNeedsYouItem } from "@/server/digest-rules";
import { countQueue, queueCardIds, queueMembership } from "@/server/drafts";
import { emergencyAlertText } from "@/server/emergency-alert-rules";
import { emergencySummary } from "@/server/emergency-alerts";
import { leadsAtRisk } from "@/server/leads-at-risk";
import { notificationUrl, queueDeepLink } from "@/server/leads-at-risk-rules";
import { newQuotesWithoutCard, pushSummaryText } from "@/server/push-alerts";
import { canSend } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";
import { termsRequiredResponse } from "@/server/session";
import { termsAccepted } from "@/server/terms";
import { workspaceTimeZone } from "@/server/snooze";
import { usableTimeZone } from "@/server/snooze-rules";

export const dynamic = "force-dynamic";

/**
 * Plan #36: the service worker asks this when an (empty) push arrives, with
 * the owner's own cookie, and shows the answer. Counts only, plus where a tap
 * goes: a queue card by its thread id (a uuid), the quote tracker or the queue
 * (plan #34) — never a name, an address or a subject. Right after an emergency alert it
 * says "An emergency email just came in." and opens that card (replies package, B5 part 2). `count` is the number for the
 * home-screen badge (plan #38): replies + needs-you, 0 for a read-only account (M8 A6).
 */
export async function GET() {
  const session = await auth();
  const workspace = session?.user?.id ? await getWorkspaceForUser(session.user.id) : null;
  if (!workspace) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  // Not agreed to the current terms (Davi, 2026-10-15): 403, never a redirect.
  if (!(await termsAccepted(session!.user.id))) return termsRequiredResponse();
  // M11 C8: a script polling this can't hammer the database (phones ask far less often).
  const limit = await hitLimit("poll", workspace.id);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec), "Cache-Control": "no-store" },
      },
    );
  }
  const now = new Date();
  // Content-free membership of the queue (plan M8 A1) — the same rules as queueCounts, never
  // listQueue — and the leads that have waited past the mark (ids and times only).
  const [q, atRisk, emergency] = await Promise.all([
    queueMembership(workspace.id, now),
    workspaceTimeZone(workspace.id).then((tz) =>
      leadsAtRisk(workspace.id, now, usableTimeZone(tz)),
    ),
    emergencySummary(workspace.id, now),
  ]);
  const counts = countQueue(q);
  const onQueue = queueCardIds(q);
  // Replies package (B5 part 2): right after an emergency push, the phone says so and the tap
  // opens that card (`/queue?t=<uuid>#t-<uuid>`, which sw.js allows) — still no name or words.
  const emergencyCard = emergency?.threadIds.find((id) => onQueue.has(id));
  // Check 19 P1: a fresh quote request with no reply drafted yet isn't on the queue: name it
  // (as a count) and, when nothing else has a card to open, send the tap to Quotes. A lead
  // already counted as at risk isn't counted twice.
  const quotes = await newQuotesWithoutCard(
    workspace.id,
    onQueue,
    now,
    new Set(atRisk.map((l) => l.threadId)),
  );
  const newQuotes = quotes.count;
  const leadUrl = notificationUrl({
    atRisk: atRisk.map((l) => l.threadId),
    needsYou: headerPicks(q.needsYou.map(toNeedsYouItem)).map((i) => i.threadId),
    onQueue,
  });
  const url = emergency
    ? emergencyCard
      ? queueDeepLink(emergencyCard)
      : "/queue"
    : leadUrl === "/queue" && newQuotes > 0
      ? "/quotes"
      : leadUrl;
  return NextResponse.json(
    {
      title: "Squared Away",
      body: emergency
        ? emergencyAlertText(emergency.threadIds.length)
        : pushSummaryText({
            replies: counts.drafts,
            needsYou: counts.needsYou,
            atRisk: atRisk.length,
            newQuotes,
            waiting: quotes.waiting,
            canSend: canSend(workspace, now),
          }),
      url,
      count: badgeCountOf(workspace, counts, now),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
