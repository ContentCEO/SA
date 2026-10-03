import { timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { mailboxes } from "@/db/schema";
import { enqueue, mailboxSyncRequested } from "@/jobs/client";

export const dynamic = "force-dynamic";

const pushBody = z.object({ message: z.object({ data: z.string() }) });
const notification = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]),
});

function tokenOk(received: string | null): boolean {
  const expected = process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Google Pub/Sub push for Gmail `watch`. The notification only says "something
 * changed for this address" — we never trust it for content, we just kick an
 * incremental sync. Always 204 on valid-but-useless pushes so Pub/Sub doesn't retry.
 */
export async function POST(request: NextRequest) {
  if (!tokenOk(request.nextUrl.searchParams.get("token"))) {
    return new NextResponse(null, { status: 403 });
  }
  const parsed = pushBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 204 });
  const note = notification.safeParse(
    JSON.parse(Buffer.from(parsed.data.message.data, "base64").toString("utf8") || "null"),
  );
  if (!note.success) return new NextResponse(null, { status: 204 });

  const boxes = await db()
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.status, "active"),
        sql`lower(${mailboxes.email}) = ${note.data.emailAddress.toLowerCase()}`,
      ),
    );
  for (const b of boxes) await enqueue(mailboxSyncRequested.create({ mailboxId: b.id }));
  return new NextResponse(null, { status: 204 });
}
