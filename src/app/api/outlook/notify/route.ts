import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { outlookOffered } from "@/config/outlook";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { enqueue, mailboxSyncRequested } from "@/jobs/client";
import { mailboxRunning } from "@/server/mailbox-plan";
import { clientStateMatches } from "@/server/outlook-push";

export const dynamic = "force-dynamic";

const notifications = z.object({
  value: z
    .array(
      z.object({
        subscriptionId: z.string().max(200),
        clientState: z.string().max(200).optional(),
      }),
    )
    .max(1000),
});

/**
 * Plan #49: Microsoft Graph change notifications for Outlook mailboxes. 404 unless Outlook is
 * offered (FEATURE_OUTLOOK + the Azure app's credentials).
 *
 * - Graph's validation handshake (`?validationToken=…` when a subscription is made): the token is
 *   echoed back as text/plain, which is all Graph asks.
 * - A notification only says "something changed in this mailbox": each one's `clientState` must
 *   match the random value we gave that subscription (only its sha256 is stored, compared in
 *   constant time), and then the mailbox's sync is enqueued. No content is read or handled here.
 *   A batch where nothing matched and something carried a wrong clientState is a 403; one for a
 *   subscription we no longer know (an orphan after Disconnect) is acknowledged so Graph stops.
 */
export async function POST(request: NextRequest) {
  if (!outlookOffered()) return new NextResponse(null, { status: 404 });
  const validationToken = request.nextUrl.searchParams.get("validationToken");
  if (validationToken !== null) {
    if (validationToken.length > 2048) return new NextResponse(null, { status: 400 });
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  const parsed = notifications.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const ids = [...new Set(parsed.data.value.map((n) => n.subscriptionId))];
  if (ids.length === 0) return new NextResponse(null, { status: 202 });
  const boxes = await db()
    .select({
      id: mailboxes.id,
      subscriptionId: mailboxes.pushSubscriptionId,
      clientStateSha256: mailboxes.pushClientStateSha256,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "outlook"), inArray(mailboxes.pushSubscriptionId, ids)));
  const bySub = new Map(boxes.map((b) => [b.subscriptionId, b]));
  const wake = new Set<string>();
  let refused = 0;
  for (const n of parsed.data.value) {
    const box = bySub.get(n.subscriptionId);
    if (!box) continue;
    if (clientStateMatches(box.clientStateSha256, n.clientState)) wake.add(box.id);
    else refused++;
  }
  if (wake.size === 0 && refused > 0) return new NextResponse(null, { status: 403 });
  if (wake.size) {
    // Lost access or paused on the plan: nothing to sync.
    const running = await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(mailboxRunning(), inArray(mailboxes.id, [...wake])));
    for (const b of running) await enqueue(mailboxSyncRequested.create({ mailboxId: b.id }));
  }
  return new NextResponse(null, { status: 202 });
}
