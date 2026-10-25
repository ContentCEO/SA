"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ReadOnlyError } from "@/server/lifecycle";
import { LOST_REASONS, parseDollars } from "@/server/quote-rules";
import {
  markQuoteSentAnotherWay,
  setLostReason,
  setQuoteAmount,
  setQuoteDismissed,
  setQuoteOutcome,
} from "@/server/quotes";
import { requireOwner } from "@/server/session";

const input = z.object({
  threadId: z.string().uuid(),
  outcome: z.enum(["won", "lost", "no_answer", "reopen"]),
  stage: z.string().max(20).optional(),
});

/**
 * One tap: Won, Lost, No answer, or Reopen — also to change our guess. Only "Save as won"
 * takes an amount (Check 11 P7): it replaces the detected one; an amount sent with any other
 * outcome is refused (error=amount). Read-only accounts change nothing.
 */
export async function markQuoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({
    threadId: formData.get("threadId"),
    outcome: formData.get("outcome"),
    stage: formData.get("stage") ?? undefined,
  });
  if (!parsed.success) redirect("/quotes?error=unknown");
  const raw = formData.get("amount");
  const amount = typeof raw === "string" && raw.trim() ? parseDollars(raw) : undefined;
  if (amount === null) redirect("/quotes?error=amount");
  const { threadId, outcome, stage } = parsed.data;
  if (amount !== undefined && outcome !== "won") redirect("/quotes?error=amount");
  let ok: boolean;
  try {
    ok = await setQuoteOutcome(
      workspace.id,
      threadId,
      outcome === "reopen" ? null : outcome,
      amount,
    );
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/quotes?error=readonly");
    throw err;
  }
  const back = stage ? `&stage=${encodeURIComponent(stage)}` : "";
  redirect(ok ? `/quotes?done=${outcome}${back}` : "/quotes?error=unknown");
}

/** Check 11 P7: "Change amount" on a won quote. Read-only accounts change nothing. */
export async function changeAmountAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = z
    .object({ threadId: z.string().uuid(), stage: z.string().max(20).optional() })
    .safeParse({
      threadId: formData.get("threadId"),
      stage: formData.get("stage") ?? undefined,
    });
  if (!parsed.success) redirect("/quotes?error=unknown");
  const raw = formData.get("amount");
  const amount = typeof raw === "string" ? parseDollars(raw) : null;
  if (amount === null) redirect("/quotes?error=amount");
  let r;
  try {
    r = await setQuoteAmount(workspace.id, parsed.data.threadId, amount);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/quotes?error=readonly");
    throw err;
  }
  const back = parsed.data.stage ? `&stage=${encodeURIComponent(parsed.data.stage)}` : "";
  redirect(r === "ok" ? `/quotes?done=amount${back}` : "/quotes?error=unknown");
}

/** Ideas C5: "Why did you lose it?" — one tap, optional. Only on a quote that is lost. */
export async function lostReasonAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = z
    .object({
      threadId: z.string().uuid(),
      reason: z.enum(LOST_REASONS),
      stage: z.string().max(20).optional(),
    })
    .safeParse({
      threadId: formData.get("threadId"),
      reason: formData.get("reason"),
      stage: formData.get("stage") ?? undefined,
    });
  if (!parsed.success) redirect("/quotes?error=unknown");
  let r;
  try {
    r = await setLostReason(workspace.id, parsed.data.threadId, parsed.data.reason);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/quotes?error=readonly");
    throw err;
  }
  const back = parsed.data.stage ? `&stage=${encodeURIComponent(parsed.data.stage)}` : "";
  redirect(r === "ok" ? `/quotes?done=lost_reason${back}` : "/quotes?error=unknown");
}

/**
 * Check 11 P8: "I sent the price another way" (QuickBooks, Jobber…). Counts as the owner's
 * answer, with the price typed if any. Drafts and sends nothing.
 */
export async function sentAnotherWayAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const threadId = z.string().uuid().safeParse(formData.get("threadId"));
  if (!threadId.success) redirect("/quotes?error=unknown");
  const raw = formData.get("amount");
  const amount = typeof raw === "string" && raw.trim() ? parseDollars(raw) : undefined;
  if (amount === null) redirect("/quotes?error=amount");
  let r;
  try {
    r = await markQuoteSentAnotherWay(workspace.id, threadId.data, amount ?? null);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/quotes?error=readonly");
    throw err;
  }
  redirect(r === "marked" ? "/quotes?done=sent_other" : "/quotes?error=unknown");
}

/** Check 11 P8: "Not a quote" and "Put back". Only the mark changes. */
export async function dismissQuoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = z
    .object({ threadId: z.string().uuid(), dismiss: z.enum(["yes", "no"]) })
    .safeParse({ threadId: formData.get("threadId"), dismiss: formData.get("dismiss") });
  if (!parsed.success) redirect("/quotes?error=unknown");
  const dismiss = parsed.data.dismiss === "yes";
  let ok;
  try {
    ok = await setQuoteDismissed(workspace.id, parsed.data.threadId, dismiss);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/quotes?error=readonly");
    throw err;
  }
  redirect(ok ? `/quotes?done=${dismiss ? "dismissed" : "restored"}` : "/quotes?error=unknown");
}
