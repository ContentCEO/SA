import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businessProfiles, mailboxes } from "@/db/schema";
import { isCrewAddress, type CrewContext } from "./sender-rules";

/**
 * Check 22 P10 + 41 P6: what decides "the owner's own people" for one workspace — the crew
 * list from Settings and the connected Gmail addresses (their business domain counts too).
 * Never logged.
 */
export async function crewContextFor(workspaceId: string): Promise<CrewContext> {
  const [profile] = await db()
    .select({ crew: businessProfiles.crewAddresses })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const boxes = await db()
    .select({ email: mailboxes.email })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  return { listed: profile?.crew ?? [], mailboxEmails: boxes.map((b) => b.email) };
}

/** One address, read live. */
export async function isCrewFor(workspaceId: string, address: string | null | undefined) {
  if (!address) return false;
  return isCrewAddress(address, await crewContextFor(workspaceId));
}
