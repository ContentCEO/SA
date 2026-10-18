"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  CheckoutNotAllowedError,
  createCheckout,
  createPortal,
  noteStripeWaiting,
} from "@/server/billing";
import type { PlanId } from "@/config/pricing";
import { checkoutTerms } from "@/server/billing-rules";
import { isPlanId } from "@/server/billing-rules";
import { hitLimit } from "@/server/rate-limit";
import { goBackToPaidPlan, keepFreePlan, type PlanChangeOutcome } from "@/server/referrals";
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

const keepInput = z.object({
  rewardId: z.uuid(),
  plan: z.custom<PlanId>((v) => isPlanId(v)),
  priceCents: z.coerce.number().int().nonnegative(),
});
const goBackInput = z.object({ rewardId: z.uuid() });

/** Where a Keep / Go back tap lands: the notice uses the button's word, errors say what to do. */
function planChangeRedirect(outcome: PlanChangeOutcome): never {
  switch (outcome.status) {
    case "kept":
      redirect("/billing?done=kept#free-month");
    case "went_back":
      redirect("/billing?done=went_back#free-month");
    case "busy":
      // The claim is held by another tap (not the rate limit, which has its own message).
      redirect("/billing?error=plan_busy#free-month");
    default:
      redirect(`/billing?error=${outcome.status}#free-month`);
  }
}

/**
 * Plan #47 "Keep Crew": the owner's explicit tap, naming the plan and the price they confirmed.
 * Everything is re-checked on the server (the offer, the price, Stripe's live subscription).
 */
export async function keepFreePlanAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const input = keepInput.safeParse({
    rewardId: formData.get("rewardId"),
    plan: formData.get("plan"),
    priceCents: formData.get("priceCents"),
  });
  if (!input.success) redirect("/billing?error=not_offered#free-month");
  if (!(await hitLimit("billing", workspace.id)).allowed) redirect("/billing?error=busy");
  planChangeRedirect(await keepFreePlan(workspace.id, input.data));
}

/** Plan #47 "Go back to Solo" after a Keep: back to exactly the price they paid before. */
export async function goBackAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const input = goBackInput.safeParse({ rewardId: formData.get("rewardId") });
  if (!input.success) redirect("/billing?error=not_offered#free-month");
  if (!(await hitLimit("billing", workspace.id)).allowed) redirect("/billing?error=busy");
  planChangeRedirect(await goBackToPaidPlan(workspace.id, input.data));
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
