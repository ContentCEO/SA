import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "./accounts";

/** For pages and server actions: the signed-in owner and their workspace, or back to sign-in. */
export async function requireOwner() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/");
  const workspace = await getWorkspaceForUser(userId);
  if (!workspace) redirect("/");
  return { session, userId, workspace };
}
