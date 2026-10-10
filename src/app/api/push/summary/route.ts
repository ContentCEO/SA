import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { listQueue } from "@/server/drafts";
import { pushSummaryText } from "@/server/push-alerts";

export const dynamic = "force-dynamic";

/**
 * Plan #36: the service worker asks this when an (empty) push arrives, with
 * the owner's own cookie, and shows the answer. Counts only.
 */
export async function GET() {
  const session = await auth();
  const workspace = session?.user?.id ? await getWorkspaceForUser(session.user.id) : null;
  if (!workspace) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const q = await listQueue(workspace.id);
  return NextResponse.json(
    {
      title: "Squared Away",
      body: pushSummaryText({ replies: q.drafts.length, needsYou: q.needsYou.length }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
