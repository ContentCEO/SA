"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { markNeedsOwner } from "@/server/classification";
import { createDraftForThread, type OwnerPurpose } from "@/server/drafts";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";
import { isCategory } from "@/config/categories";
import { OWNER_SENDER_RULE_ACTIONS, OWNER_SENDER_RULE_SCOPES } from "@/db/schema";
import { ReadOnlyError } from "@/server/lifecycle";
import { saveRule } from "@/server/sender-rule-store";
import { resortThread } from "@/server/resort";

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
  gmail_busy: "gmail_busy",
  reply_to_unread: "reply_to_unread",
  no_reply_address: "no_reply_address",
  text_address: "textaddr",
  lead_site: "leadsite",
  phone_message: "phonemsg",
  feature_off: "feature_off",
  not_eligible: "not_eligible",
  customer_replied: "not_eligible",
  not_found: "unknown",
  // Gmail needs a reconnect: trying again won't help until they do.
  mailbox_inactive: "reconnect",
  mailbox_paused: "paused",
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
  if (purpose === "thank_you" && r.reason === "already_asked") redirect("/queue?error=thanked");
  redirect(`/queue?error=${OFFER_ERRORS[r.reason] ?? "draftfailed"}`);
}

export async function askForReviewAction(formData: FormData) {
  await askFor("review_request", formData);
}

export async function askClosingQuestionAction(formData: FormData) {
  await askFor("closing_question", formData);
}

/** "Say thanks" on a paid Money row (2026-10-16). Drafts only, like every offer. */
export async function sayThanksAction(formData: FormData) {
  await askFor("thank_you", formData);
}

/** Ideas H4: "Move it". Fixes this conversation only; the server re-checks everything. */
export async function resortAction(formData: FormData) {
  const { workspace } = await requireOwner();
  // Back to the screen the sheet was on, with a fixed notice code (never anything typed).
  const onQueue = formData.get("back") === "queue";
  const back = (q: string) => (onQueue ? `/queue?${q}` : `/inbox?${q}`);
  const parsed = input.safeParse({ threadId: formData.get("threadId") });
  const category = formData.get("category");
  if (!parsed.success || !isCategory(category)) redirect(back(`error=unknown`));
  if (!(await hitLimit("gmailWrite", workspace.id)).allowed) redirect(back(`error=busy`));
  let r;
  try {
    r = await resortThread(workspace.id, parsed.data.threadId, category);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect(back(`error=readonly`));
    throw err;
  }
  if (r === "sending") redirect(back(`error=resort_sending`));
  if (r === "not_found") redirect(back(`error=unknown`));
  redirect(back(`done=moved_${category}`));
}

/** Ideas H3: "Save rule". Posts an email's id; the server works out the address. */
export async function saveSenderRuleAction(formData: FormData) {
  const { workspace } = await requireOwner();
  // Back to the screen the sheet was on, with a fixed notice code (never anything typed).
  const onQueue = formData.get("back") === "queue";
  const back = (q: string) => (onQueue ? `/queue?${q}` : `/inbox?${q}`);
  const parsed = z
    .object({
      messageId: z.string().uuid(),
      action: z.enum(OWNER_SENDER_RULE_ACTIONS),
      scope: z.enum(OWNER_SENDER_RULE_SCOPES),
    })
    .safeParse({
      messageId: formData.get("messageId"),
      action: formData.get("action"),
      scope: formData.get("scope"),
    });
  if (!parsed.success) redirect(back(`error=unknown`));
  let r;
  try {
    r = await saveRule(workspace.id, parsed.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect(back(`error=readonly`));
    throw err;
  }
  if (r.status === "vip") redirect(back(`done=vip_added`));
  if (r.status === "saved") redirect(back(`done=rule_saved`));
  redirect(back(`error=rule_${r.why}`));
}
