import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { sendDraft } from "@/server/drafts";
import { SendingBlockedError } from "@/server/lifecycle";
import { hitLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * JSON endpoint for sending a draft. The UI uses a server action, but the gate
 * is the same function, so hitting this directly during evaluation gets a 403.
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
    const outcome = await sendDraft(workspace.id, id, { editedBody });
    const code = outcome.status === "sent" ? 200 : outcome.status === "not_found" ? 404 : 409;
    return NextResponse.json(outcome, { status: code });
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
