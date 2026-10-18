"use server";

import { redirect } from "next/navigation";
import {
  CheckoutNotAllowedError,
  createCheckout,
  createPortal,
  noteStripeWaiting,
} from "@/server/billing";
import { checkoutTerms } from "@/server/billing-rules";
import { isPlanId } from "@/server/billing-rules";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

export async function startCheckoutAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const plan = formData.get("plan");
  if (!isPlanId(plan)) redirect("/billing?error=unknown");
  if (!(await hitLimit("billing", workspace.id)).allowed) redirect("/billing?error=busy");
  let url: string;
  try {
    url = await createCheckout(workspace, plan);
  } catch (err) {
    if (err instanceof CheckoutNotAllowedError) redirect("/billing?error=has_plan");
    throw err;
  }
  redirect(url);
}

export async function openPortalAction() {
  const { workspace } = await requireOwner();
  if (!(await hitLimit("billing", workspace.id)).allowed) redirect("/billing?error=busy");
  let url: string;
  try {
    url = await createPortal(workspace);
  } catch (err) {
    if (err instanceof CheckoutNotAllowedError) redirect("/billing?error=unknown");
    throw err;
  }
  redirect(url);
}

/**
 * Check 17 P9: the waiting page ran out of refreshes. Records it for /admin (rate-limited);
 * only while the account still has no plan from Stripe. Changes nothing else.
 */
export async function reportStripeWaitingAction(sessionId: string | null) {
  const { workspace } = await requireOwner();
  if (!checkoutTerms(workspace).allowed) return;
  if (!(await hitLimit("billing", workspace.id)).allowed) return;
  await noteStripeWaiting(workspace.id, typeof sessionId === "string" ? sessionId : null);
}
