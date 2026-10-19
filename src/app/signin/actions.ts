"use server";

import { cookies } from "next/headers";
import { signIn } from "@/auth";
import {
  AGREE_FIELD,
  AGREE_REQUIRED_MESSAGE,
  TERMS_COOKIE,
  TERMS_COOKIE_MAX_AGE_SECONDS,
  TERMS_COOKIE_PATH,
  TERMS_VERSION,
} from "@/config/legal";
import { agreed, type AgreeState, safeNextPath } from "@/server/terms-rules";

/**
 * The Sign in with Google button (Davi, 2026-10-15). Refused without the "I agree" box, here on
 * the server, whatever the browser did. With it, a short-lived cookie carries the terms version
 * to Google's callback, where Auth.js records the acceptance on the account (src/server/terms.ts
 * takeSignInAgreement), and Auth.js starts Google's sign-in. Public on purpose: nobody is signed
 * in yet. Sign-in still only asks Google for name and email, and only invited addresses get in.
 */
export async function signInWithGoogleAction(
  _prev: AgreeState,
  formData: FormData,
): Promise<AgreeState> {
  if (!agreed(formData.get(AGREE_FIELD))) return { error: AGREE_REQUIRED_MESSAGE };
  (await cookies()).set(TERMS_COOKIE, TERMS_VERSION, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: TERMS_COOKIE_PATH,
    maxAge: TERMS_COOKIE_MAX_AGE_SECONDS,
  });
  // Check 26 P4: asked to sign in again (to delete the account), back to that screen — a path
  // on this site only (safeNextPath).
  const next = formData.get("next");
  if (typeof next === "string" && next) {
    await signIn("google", { redirectTo: safeNextPath(next) });
    return {};
  }
  // /start sends Growth clients to the choice of inbox or Growth dashboard, everyone else to /queue.
  await signIn("google", { redirectTo: "/start" });
  return {};
}
