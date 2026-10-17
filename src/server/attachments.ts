import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import type { AttachmentCounts } from "./attachment-rules";

/**
 * Check 40 P2: what the customer attached on each conversation (their emails only, not an
 * automatic reply), summed by kind. Counts only.
 */
export async function attachmentsForThreads(
  threadIds: string[],
): Promise<Map<string, AttachmentCounts>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db()
    .select({
      threadId: messages.threadId,
      images: sql<number>`coalesce(sum(${messages.attachmentImages}), 0)::int`,
      pdfs: sql<number>`coalesce(sum(${messages.attachmentPdfs}), 0)::int`,
      other: sql<number>`coalesce(sum(${messages.attachmentOther}), 0)::int`,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.threadId, threadIds),
        eq(messages.direction, "in"),
        eq(messages.autoReply, false),
      ),
    )
    .groupBy(messages.threadId);
  return new Map(
    rows.map((r) => [
      r.threadId,
      { images: Number(r.images), pdfs: Number(r.pdfs), other: Number(r.other) },
    ]),
  );
}
