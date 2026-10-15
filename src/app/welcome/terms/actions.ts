"use server";

import { redirect } from "next/navigation";
import { AGREE_FIELD, AGREE_REQUIRED_MESSAGE } from "@/config/legal";
import { requireSignedIn } from "@/server/session";
import { recordTermsAcceptance } from "@/server/terms";
import { agreed, type AgreeState, safeNextPath } from "@/server/terms-rules";

/**
 * "Agree and continue" on /welcome/terms (Davi, 2026-10-15). The box is checked here on the
 * server; then the acceptance (time and version) goes on the account and they go back where
 * they were heading — a path on this site only (safeNextPath), else the queue.
 */
export async function agreeToTermsAction(
  _prev: AgreeState,
  formData: FormData,
): Promise<AgreeState> {
  const { userId } = await requireSignedIn();
  if (!agreed(formData.get(AGREE_FIELD))) return { error: AGREE_REQUIRED_MESSAGE };
  await recordTermsAcceptance(userId);
  redirect(safeNextPath(formData.get("next")));
}
