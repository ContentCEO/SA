"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { enqueue, voiceLearnRequested } from "@/jobs/client";
import {
  businessProfileInput,
  digestSettingsInput,
  followupSettingsInput,
  saveBusinessProfile,
  saveDigestSettings,
  saveFollowupSettings,
  saveVoiceEdits,
  voiceEditInput,
} from "@/server/profile";
import { AutopilotNotAllowedError, setAutopilot } from "@/server/autopilot";
import { decideSuggestion } from "@/server/edit-learning";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";

export type FormState = { errors?: Record<string, string[]>; values?: Record<string, string> };

function values(formData: FormData): Record<string, string> {
  return Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
}

const returnTo = z.enum(["/settings?done=profile", "/welcome/learning"]);

export async function saveBusinessProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { workspace } = await requireOwner();
  const raw = values(formData);
  const parsed = businessProfileInput.safeParse(raw);
  if (!parsed.success)
    return {
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values: raw,
    };
  await saveBusinessProfile(workspace.id, parsed.data);
  redirect(returnTo.catch("/settings?done=profile").parse(raw.returnTo));
}

export async function saveVoiceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { workspace } = await requireOwner();
  const raw = values(formData);
  const parsed = voiceEditInput.safeParse(raw);
  if (!parsed.success)
    return {
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values: raw,
    };
  await saveVoiceEdits(workspace.id, parsed.data);
  redirect("/settings?done=voice");
}

export async function relearnVoiceAction() {
  const { workspace } = await requireOwner();
  if (!(await hitLimit("relearn", workspace.id)).allowed) redirect("/settings?error=relearn_busy");
  await enqueue(voiceLearnRequested.create({ workspaceId: workspace.id, force: true }));
  redirect("/settings?done=relearn");
}

export async function saveFollowupSettingsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = followupSettingsInput.safeParse({
    enabled: formData.get("enabled") ?? undefined,
    days: formData.get("days"),
  });
  if (!parsed.success) redirect("/settings?error=unknown");
  await saveFollowupSettings(workspace.id, parsed.data);
  redirect("/settings?done=followups");
}

export async function saveDigestSettingsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = digestSettingsInput.safeParse({
    enabled: formData.get("enabled") ?? undefined,
    hour: formData.get("hour"),
    timeZone: formData.get("timeZone"),
  });
  if (!parsed.success) redirect("/settings?error=unknown");
  await saveDigestSettings(workspace.id, parsed.data);
  redirect("/settings?done=digest");
}

/** Turning autopilot on is re-checked server-side (plan, setup done, earned); off always works. */
export async function setAutopilotAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const category = String(formData.get("category") ?? "");
  const on = formData.get("on") === "1";
  try {
    await setAutopilot(workspace, category, on);
  } catch (err) {
    if (err instanceof AutopilotNotAllowedError) redirect("/settings?error=autopilot#autopilot");
    throw err;
  }
  redirect(`/settings?done=${on ? "autopilot_on" : "autopilot_off"}#autopilot`);
}

/** Plan #21: the owner's yes or no to an idea from their edits. */
export async function decideVoiceIdeaAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = z.string().uuid().safeParse(formData.get("ideaId"));
  if (!id.success) redirect("/settings?error=unknown");
  const r = await decideSuggestion(workspace.id, id.data, formData.get("answer") === "yes");
  if (r === "type_it") redirect("/settings/voice");
  redirect(
    r === "accepted"
      ? "/settings?done=idea_yes#voice"
      : r === "ignored"
        ? "/settings?done=idea_no#voice"
        : "/settings?error=unknown",
  );
}
