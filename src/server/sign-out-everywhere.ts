import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, users, workspaces } from "@/db/schema";

/**
 * Check 26 P3: "Sign out of every phone and computer". Moves the account's session version on,
 * so every sign-in made before now stops working on its next request. False: no such account.
 */
async function bumpSessionVersion(userId: string): Promise<boolean> {
  const [row] = await db()
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return Boolean(row);
}

/**
 * Check 26 P3: end every sign-in on a workspace owner's account — the owner's "Sign out of every
 * phone and computer", or Davi's admin move (the caller has checked who's asking). One
 * content-free Activity row says who did it.
 */
export async function signOutEverywhere(
  workspaceId: string,
  by: "owner" | "admin",
): Promise<boolean> {
  const [w] = await db()
    .select({ ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!w || !(await bumpSessionVersion(w.ownerUserId))) return false;
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: by === "owner" ? "owner" : "squared_away",
      action: "signed_out_everywhere",
      detail: { by },
    });
  return true;
}
