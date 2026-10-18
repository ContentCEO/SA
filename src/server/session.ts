import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { REQUEST_PATH_HEADER, TERMS_REQUIRED_API_MESSAGE } from "@/config/legal";
import { getWorkspaceForSession, signInIsCurrent } from "./accounts";
import { isAdminEmail } from "./admin";
import { termsAccepted } from "./terms";
import { safeNextPath } from "./terms-rules";

/**
 * Not agreed to the current terms (Davi, 2026-10-15): off to /welcome/terms, which sends them
 * back to the screen they asked for (the path the proxy saw, src/proxy.ts) once they agree.
 */
async function toTermsScreen(): Promise<never> {
  const back = safeNextPath((await headers()).get(REQUEST_PATH_HEADER));
  redirect(`/welcome/terms?next=${encodeURIComponent(back)}`);
}

/**
 * For pages and server actions: the signed-in owner and their workspace, or back to sign-in.
 * Someone who hasn't agreed to the current terms goes to /welcome/terms first.
 */
export async function requireOwner() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");
  // Check 26 P3: a sign-in from before "Sign out of every phone and computer" gets nothing.
  const [workspace, agreed] = await Promise.all([
    getWorkspaceForSession(session.user),
    termsAccepted(userId),
  ]);
  if (!workspace) redirect("/signin");
  if (!agreed) await toTermsScreen();
  return { session, userId, workspace };
}

/**
 * Only for /welcome/terms (its page and its action): signed in with a workspace, whether or not
 * they have agreed yet. Every other screen and action uses requireOwner().
 */
export async function requireSignedIn() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");
  const workspace = await getWorkspaceForSession(session.user);
  if (!workspace) redirect("/signin");
  return { session, userId, workspace };
}

/**
 * /admin is Davi's only. Anyone else gets a plain 404 — we don't confirm it exists. Davi agrees
 * to the current terms too (the same screen as everyone).
 */
export async function requireAdmin() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) notFound();
  const userId = session!.user.id;
  if (!userId) redirect("/signin");
  // Check 26 P3: Davi's sign-ins end with "Sign out everywhere" like everyone's.
  const [current, agreed] = await Promise.all([
    signInIsCurrent(session!.user),
    termsAccepted(userId),
  ]);
  if (!current) redirect("/signin");
  if (!agreed) await toTermsScreen();
  return session!;
}

/**
 * Check 26 P4: for actions that can't be undone (Delete my account). The person must have
 * signed in with Google in the last `maxAgeMinutes` — not just kept a sign-in alive on a phone
 * left unlocked — else back to /signin, which brings them back to this screen afterwards.
 * Call it after requireOwner()/requireSignedIn() (who's asking is checked there).
 */
export async function requireRecentSignIn(maxAgeMinutes: number, now: Date = new Date()) {
  const session = await auth();
  const at = session?.user?.sat;
  const fresh =
    typeof at === "number" &&
    at * 1000 <= now.getTime() + 60_000 &&
    now.getTime() - at * 1000 <= maxAgeMinutes * 60_000;
  if (fresh) return;
  const back = safeNextPath((await headers()).get(REQUEST_PATH_HEADER));
  redirect(`/signin?next=${encodeURIComponent(back)}&reason=recent`);
}

/**
 * For API routes that use the session, right after the workspace check (401): someone who hasn't
 * agreed to the current terms gets a 403, never a redirect (a fetch would follow it silently).
 */
export function termsRequiredResponse() {
  return NextResponse.json(
    { error: TERMS_REQUIRED_API_MESSAGE, status: "terms_required" },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
