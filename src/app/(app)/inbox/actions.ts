"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { markNeedsOwner } from "@/server/classification";
import { createDraftForThread, type OwnerPurpose } from "@/server/drafts";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

const input = z.object({ threadId: z.string().uuid() });

export async function markNeedsOwnerAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ threadId: formData.get("threadId") });
  if (!parsed.success) return;
  await markNeedsOwner(workspace.id, parsed.data.threadId);
  revalidatePath("/inbox");
}

/** Skip reasons → the Queue's ?error= keys. Anything else is a plain "couldn't write it". */
const OFFER_ERRORS: Record<string, string> = {
  already_pending: "exists",
  read_only: "readonly",
  capped: "capped",
  no_text: "notext",
  review_recent: "review_recent",
  no_review_link: "no_review_link",
  already_asked: "already_asked",
  complaint: "complaint",
  feature_off: "feature_off",
  not_eligible: "not_eligible",
  customer_replied: "not_eligible",
  not_found: "unknown",
  // Gmail needs a reconnect: trying again won't help until they do.
  mailbox_inactive: "reconnect",
};

/**
 * The owner's tap on an offer (plan #29, #26). Only drafts — the note waits in the Queue
 * like any other reply. Every rule is re-checked in createDraftForThread, whatever the
 * screen showed.
 */
async function askFor(purpose: OwnerPurpose, formData: FormData): Promise<never> {
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ threadId: formData.get("threadId") });
  if (!parsed.success) redirect("/queue?error=unknown");
  if (!(await hitLimit("draft", workspace.id)).allowed) redirect("/queue?error=busy");
  const r = await createDraftForThread(parsed.data.threadId, {
    trigger: "owner",
    workspaceId: workspace.id,
    purpose,
  });
  if (r.status === "created") redirect("/queue?done=drafted");
  if (r.status === "reconnect_needed") redirect("/queue?error=reconnect");
  redirect(`/queue?error=${OFFER_ERRORS[r.reason] ?? "draftfailed"}`);
}

export async function askForReviewAction(formData: FormData) {
  await askFor("review_request", formData);
}

export async function askClosingQuestionAction(formData: FormData) {
  await askFor("closing_question", formData);
}
