import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { draftSendQueued, enqueue } from "@/jobs/client";
import { queueSend } from "@/server/drafts";
import { SendingBlockedError } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * JSON endpoint for sending a draft. The UI uses a server action, but the gate
 * is the same function, so hitting this directly during evaluation gets a 403.
 * Like a tap, it starts the undo window (plan #7): 202 with the send time.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/drafts/[id]/send">) {
  // CSRF: only same-origin requests may send.
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== request.headers.get("host")) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const workspace = await getWorkspaceForUser(session.user.id);
  if (!workspace) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const limit = await hitLimit("send", workspace.id);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many sends in a short time. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  const payload = (await request.json().catch(() => ({}))) as { body?: unknown };
  const editedBody =
    typeof payload.body === "string" && payload.body.trim() ? payload.body : undefined;

  try {
    const outcome = await queueSend(workspace.id, id, { editedBody });
    if (outcome.status === "gaps_unfilled") {
      return NextResponse.json(
        { error: "Fill in every highlighted gap before sending." },
        { status: 422 },
      );
    }
    if (outcome.status === "queued") {
      await enqueue(draftSendQueued.create({ draftId: id, at: outcome.sendAfter.toISOString() }));
      return NextResponse.json(outcome, { status: 202 });
    }
    return NextResponse.json(outcome, { status: outcome.status === "not_found" ? 404 : 409 });
  } catch (err) {
    if (err instanceof SendingBlockedError) {
      return NextResponse.json(
        { error: "Sending is not allowed for this account right now." },
        { status: 403 },
      );
    }
    throw err;
  }
}
