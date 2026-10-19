import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { businessProfiles } from "@/db/schema";
import { getWorkspaceForUser } from "@/server/accounts";
import { termsAccepted } from "@/server/terms";
import { ZoneCapture } from "./zone-capture";

/**
 * Check 45 P1: renders the browser zone capture only for a signed-in owner (terms agreed) whose
 * time zone was never set. Everyone else gets nothing, so nothing is posted.
 */
export async function ZoneCaptureGate() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const [workspace, agreed] = await Promise.all([
    getWorkspaceForUser(userId),
    termsAccepted(userId),
  ]);
  if (!workspace || !agreed) return null;
  const [p] = await db()
    .select({ source: businessProfiles.timeZoneSource })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspace.id));
  const source = p?.source ?? "default";
  if (source !== "default") return null;
  return <ZoneCapture timeZoneSource={source} />;
}
