"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ReadOnlyError } from "@/server/lifecycle";
import { setInvoiceNotOwed, setInvoicePaid } from "@/server/money";
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
