"use server";

import { redirect } from "next/navigation";
import { CheckoutNotAllowedError, createCheckout, createPortal } from "@/server/billing";
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
