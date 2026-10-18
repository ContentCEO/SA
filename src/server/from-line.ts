import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businessProfiles, users, workspaces } from "@/db/schema";
import { pickSenderName } from "./from-line-rules";

/**
 * Check 43 P3: the name customers see on this workspace's replies, read live (a change in
 * Settings reaches the next draft or edit). Never logged.
 */
export async function senderNameFor(workspaceId: string): Promise<string | null> {
  const [row] = await db()
    .select({
      fromName: businessProfiles.fromName,
      userName: users.name,
      businessName: workspaces.businessName,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId));
  return row ? pickSenderName(row) : null;
}
