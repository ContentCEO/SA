"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isTemporaryAiFailure } from "@/ai/client";
import { ReadOnlyError } from "@/server/lifecycle";
import { draftInvoiceReminder, setInvoiceNotOwed, setInvoicePaid } from "@/server/money";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

const input = z.object({ threadId: z.string().uuid() });
type Mark = "paid" | "unpaid" | "hidden" | "restored";

/** One tap on Money owed. Read-only accounts change nothing; another owner's row → unknown. */
async function mark(formData: FormData, what: Mark) {
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ threadId: formData.get("threadId") });
  if (!parsed.success) redirect("/money?error=unknown");
  const { threadId } = parsed.data;
  // Put back from the hidden list → stay on it, so the owner sees it went.
  const back = what === "restored" ? "&show=hidden" : "";
  let ok: boolean;
  try {
    ok =
      what === "hidden"
        ? await setInvoiceNotOwed(workspace.id, threadId)
        : await setInvoicePaid(workspace.id, threadId, what === "paid");
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect(`/money?error=readonly${back}`);
    throw err;
  }
  redirect(ok ? `/money?done=${what}${back}` : `/money?error=unknown${back}`);
}

export async function markInvoicePaidAction(formData: FormData) {
  await mark(formData, "paid");
}
export async function undoInvoicePaidAction(formData: FormData) {
  await mark(formData, "unpaid");
}
export async function notOwedAction(formData: FormData) {
  await mark(formData, "hidden");
}
export async function putBackAction(formData: FormData) {
  await mark(formData, "restored");
}

/** Why a reminder wasn't written → Money's ?error= keys (fixed codes, never anything typed). */
const REMINDER_ERRORS: Record<string, string> = {
  already_pending: "reminder_exists",
  followup_cap: "reminder_cap",
  away: "reminder_away",
  read_only: "readonly",
  mailbox_inactive: "reconnect",
  mailbox_paused: "paused",
  not_owed: "unknown",
  not_found: "unknown",
};

/**
 * Check 12 P8: "Draft a reminder" on a Money owed card. Drafts only — it waits in the Queue
 * for Send reply like every draft. Every rule is re-checked on the server.
 */
export async function draftReminderAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ threadId: formData.get("threadId") });
  if (!parsed.success) redirect("/money?error=unknown");
  if (!(await hitLimit("draft", workspace.id)).allowed) redirect("/money?error=busy");
  let r;
  try {
    r = await draftInvoiceReminder(workspace.id, parsed.data.threadId);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect("/money?error=readonly");
    if (isTemporaryAiFailure(err)) redirect("/money?error=ai_busy");
    throw err;
  }
  if (r === "created") redirect("/queue?done=drafted");
  if (r === "reconnect_needed") redirect("/money?error=reconnect");
  redirect(`/money?error=${REMINDER_ERRORS[r] ?? "reminder_failed"}`);
}
