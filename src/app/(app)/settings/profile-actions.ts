"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { enqueue, voiceLearnRequested } from "@/jobs/client";
import {
  businessProfileInput,
  followupSettingsInput,
  saveBusinessProfile,
  saveFollowupSettings,
  saveVoiceEdits,
  voiceEditInput,
} from "@/server/profile";
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
