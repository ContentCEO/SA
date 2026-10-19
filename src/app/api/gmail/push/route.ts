import { and, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { enqueue, mailboxSyncRequested } from "@/jobs/client";
import { mailboxRunning } from "@/server/mailbox-plan";
import { pushAuthorized } from "@/server/pubsub-auth";

export const dynamic = "force-dynamic";

const pushBody = z.object({ message: z.object({ data: z.string() }) });
const notification = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]),
});

/**
 * Google Pub/Sub push for Gmail `watch`. The notification only says "something
 * changed for this address" — we never trust it for content, we just kick an
 * incremental sync. Always 204 on valid-but-useless pushes so Pub/Sub doesn't retry.
 */
export async function POST(request: NextRequest) {
  // Check 26 P10: Pub/Sub's signed ID token (src/server/pubsub-auth.ts).
  if (!(await pushAuthorized(request))) {
    return new NextResponse(null, { status: 403 });
  }
  const parsed = pushBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 204 });
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(Buffer.from(parsed.data.message.data, "base64").toString("utf8"));
  } catch {
    // Garbled payload: acknowledge it so Pub/Sub doesn't retry forever; the poll covers us.
  }
  const note = notification.safeParse(decoded);
  if (!note.success) return new NextResponse(null, { status: 204 });

  const boxes = await db()
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        // Lost access or paused on the plan: nothing to sync (2026-10-16).
        mailboxRunning(),
        sql`lower(${mailboxes.email}) = ${note.data.emailAddress.toLowerCase()}`,
      ),
    );
  for (const b of boxes) await enqueue(mailboxSyncRequested.create({ mailboxId: b.id }));
  return new NextResponse(null, { status: 204 });
}
