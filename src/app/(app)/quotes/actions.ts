"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ReadOnlyError } from "@/server/lifecycle";
import { parseDollars } from "@/server/quote-rules";
import { setQuoteOutcome } from "@/server/quotes";
import { requireOwner } from "@/server/session";

const input = z.object({
  threadId: z.string().uuid(),
  outcome: z.enum(["won", "lost", "no_answer", "reopen"]),
  stage: z.string().max(20).optional(),
});

/**
 * One tap: Won, Lost, No answer, or Reopen — also to change our guess. An amount
 * typed with "Won" replaces the detected one. Read-only accounts change nothing.
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
