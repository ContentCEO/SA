import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { headerPicks, toNeedsYouItem } from "@/server/digest-rules";
import { countQueue, queueCardIds, queueMembership } from "@/server/drafts";
import { leadsAtRisk } from "@/server/leads-at-risk";
import { notificationUrl } from "@/server/leads-at-risk-rules";
import { pushSummaryText } from "@/server/push-alerts";
import { workspaceTimeZone } from "@/server/snooze";
import { usableTimeZone } from "@/server/snooze-rules";

export const dynamic = "force-dynamic";

/**
 * Plan #36: the service worker asks this when an (empty) push arrives, with
 * the owner's own cookie, and shows the answer. Counts only, plus where a tap
 * goes: a queue card by its thread id (a uuid), the quote tracker or the queue
 * (plan #34) — never a name, an address or a subject.
 */
export async function GET() {
  const session = await auth();
  const workspace = session?.user?.id ? await getWorkspaceForUser(session.user.id) : null;
  if (!workspace) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const now = new Date();
  // Content-free membership of the queue (plan M8 A1) — the same rules as queueCounts, never
  // listQueue — and the leads that have waited past the mark (ids and times only).
  const [q, atRisk] = await Promise.all([
    queueMembership(workspace.id, now),
    workspaceTimeZone(workspace.id).then((tz) =>
      leadsAtRisk(workspace.id, now, usableTimeZone(tz)),
    ),
  ]);
  const counts = countQueue(q);
  const url = notificationUrl({
    atRisk: atRisk.map((l) => l.threadId),
    needsYou: headerPicks(q.needsYou.map(toNeedsYouItem)).map((i) => i.threadId),
    onQueue: queueCardIds(q),
  });
  return NextResponse.json(
    {
      title: "Squared Away",
      body: pushSummaryText({
        replies: counts.drafts,
        needsYou: counts.needsYou,
        atRisk: atRisk.length,
      }),
      url,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
