import "server-only";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "./accounts";
import { isAdminEmail } from "./admin";

/** For pages and server actions: the signed-in owner and their workspace, or back to sign-in. */
export async function requireOwner() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/");
  const workspace = await getWorkspaceForUser(userId);
  if (!workspace) redirect("/");
  return { session, userId, workspace };
}

/** /admin is Davi's only. Anyone else gets a plain 404 — we don't confirm it exists. */
export async function requireAdmin() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) notFound();
  return session!;
}
