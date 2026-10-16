"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { planEnum, tradeEnum } from "@/db/schema";
import { inviteOwner } from "@/server/admin";
import { inviteFromWaitlist } from "@/server/waitlist";
import { connectStripe } from "@/server/billing";
import { requireAdmin } from "@/server/session";
import { stripeErrorReason } from "@/server/stripe-error-rules";
import { checkTestPayments, resetTestPayments, StripeNotLiveError } from "@/server/test-payments";
import { isAdminMove } from "@/server/lifecycle";
import {
  applyAdminMove,
  MoveNotAllowedError,
  setWorkspacePlan,
} from "@/server/workspace-lifecycle";

const id = z.string().uuid();

/** Davi's manual status moves. Re-checks admin on every call, not just the page. */
export async function adminMoveAction(formData: FormData) {
  await requireAdmin();
  const workspaceId = id.safeParse(formData.get("workspaceId"));
  const move = formData.get("move");
  if (!workspaceId.success || !isAdminMove(move)) redirect("/admin?error=unknown");
  try {
    await applyAdminMove(workspaceId.data, move);
  } catch (err) {
    if (err instanceof MoveNotAllowedError) redirect("/admin?error=move");
    throw err;
  }
  redirect(`/admin?done=${move}`);
}

const invite = z.object({
  email: z.string().trim().toLowerCase().email(),
  trade: z.enum(tradeEnum.enumValues).nullable(),
  note: z.string().trim().max(500).nullable(),
});

export async function inviteAction(formData: FormData) {
  await requireAdmin();
  const parsed = invite.safeParse({
    email: formData.get("email"),
    trade: formData.get("trade") || null,
    note: formData.get("note") || null,
  });
  if (!parsed.success) redirect("/admin?error=invite");
  const r = await inviteOwner(parsed.data);
  redirect(`/admin?done=${r}`);
}

const plan = z.enum(planEnum.enumValues).nullable();

export async function setPlanAction(formData: FormData) {
  await requireAdmin();
  const workspaceId = id.safeParse(formData.get("workspaceId"));
  const chosen = plan.safeParse(formData.get("plan") || null);
  if (!workspaceId.success || !chosen.success) redirect("/admin?error=unknown");
  await setWorkspacePlan(workspaceId.data, chosen.data);
  redirect("/admin?done=plan");
}

export async function inviteFromWaitlistAction(formData: FormData) {
  await requireAdmin();
  const email = z.string().email().safeParse(formData.get("email"));
  if (!email.success) redirect("/admin?error=unknown");
  const r = await inviteFromWaitlist(email.data);
  if (r === "growth_only") redirect("/admin?error=growth_only#waitlist");
  redirect(r === "invited" ? "/admin?done=invited#waitlist" : "/admin?error=unknown");
}

export async function connectStripeAction() {
  await requireAdmin();
  let mode: string;
  try {
    mode = (await connectStripe()).mode;
  } catch (err) {
    // M11 C10: never Stripe's own message (it can echo ids and request details) in the URL or
    // the logs — a fixed code, which the admin page turns into a plain sentence.
    const reason = stripeErrorReason(err);
    console.error("stripe_connect_failed", {
      error: err instanceof Error ? err.name : "unknown",
      reason,
    });
    redirect(`/admin?error=stripe&reason=${reason}#stripe`);
  }
  redirect(`/admin?done=stripe_${mode}#stripe`);
}

/**
 * "Check test payments": asks live Stripe which accounts still carry a test-mode payment and
 * keeps the counts for the Payments card. Changes no account. Refused in test mode.
 */
export async function checkTestPaymentsAction() {
  await requireAdmin();
  try {
    await checkTestPayments();
  } catch (err) {
    if (err instanceof StripeNotLiveError) redirect("/admin?error=stripe_test_mode#stripe");
    console.error("test_payments_check_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    redirect("/admin?error=stripe_test_payments#stripe");
  }
  redirect("/admin?done=stripe_test_check#stripe");
}

/**
 * "Reset test payments" (after one confirmation): resets every account that paid with a Stripe
 * test card, so it pays for real. Only with the live key; safe to tap again.
 */
export async function resetTestPaymentsAction() {
  await requireAdmin();
  try {
    await resetTestPayments();
  } catch (err) {
    if (err instanceof StripeNotLiveError) redirect("/admin?error=stripe_test_mode#stripe");
    console.error("test_payments_reset_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    redirect("/admin?error=stripe_test_payments#stripe");
  }
  redirect("/admin?done=stripe_test_reset#stripe");
}
