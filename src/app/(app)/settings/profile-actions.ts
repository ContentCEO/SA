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
  saveDetectedTimeZone,
  saveVoiceEdits,
  setOwnerTimeZone,
  voiceEditInput,
} from "@/server/profile";
import { isTimeZone } from "@/server/time-zone-rules";
import { AutopilotNotAllowedError, setAutopilot } from "@/server/autopilot";
import { decideSuggestion } from "@/server/edit-learning";
import { hitLimit } from "@/server/rate-limit";
import { requireOwner } from "@/server/session";
import { resumeTrialEmails, stopTrialEmails } from "@/server/trial-emails";

export type FormState = { errors?: Record<string, string[]>; values?: Record<string, string> };

function values(formData: FormData): Record<string, string> {
  return Object.fromEntries([...formData.entries()].map(([k, v]) => [k, String(v)]));
}

const returnTo = z.enum(["/settings/business?done=profile", "/welcome/learning"]);

export async function saveBusinessProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { workspace } = await requireOwner();
  const raw = values(formData);
  // Ticked boxes share one name (round 2, TW A4); the form says it sent them.
  if (formData.has("extraTradesShown"))
    raw.extraTrades = formData
      .getAll("extraTrades")
      .map((v) => String(v))
      .join(",");
  // Check 45 P1: only first-time setup sends the browser's zone; Settings saves never move it.
  if (raw.returnTo !== "/welcome/learning") delete raw.timeZone;
  const parsed = businessProfileInput.safeParse(raw);
  if (!parsed.success)
    return {
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values: raw,
    };
  await saveBusinessProfile(workspace.id, parsed.data);
  redirect(returnTo.catch("/settings/business?done=profile").parse(raw.returnTo));
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
  redirect("/settings/writing?done=voice");
}

export async function relearnVoiceAction() {
  const { workspace } = await requireOwner();
  if (!(await hitLimit("relearn", workspace.id)).allowed)
    redirect("/settings/writing?error=relearn_busy");
  await enqueue(voiceLearnRequested.create({ workspaceId: workspace.id, force: true }));
  redirect("/settings/writing?done=relearn");
}

export async function saveFollowupSettingsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = followupSettingsInput.safeParse({
    enabled: formData.get("enabled") ?? undefined,
    days: formData.get("days"),
  });
  if (!parsed.success) redirect("/settings/follow-ups?error=unknown");
  await saveFollowupSettings(workspace.id, parsed.data);
  redirect("/settings/follow-ups?done=saved");
}

export async function saveDigestSettingsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = digestSettingsInput.safeParse({
    enabled: formData.get("enabled") ?? undefined,
    hour: formData.get("hour"),
    timeZone: formData.get("timeZone") ?? undefined,
  });
  if (!parsed.success) redirect("/settings/morning-email?error=unknown");
  await saveDigestSettings(workspace.id, parsed.data);
  // Check 44 P5 / 15 P7: the visible select; saved (as the owner's pick) only when changed.
  if (parsed.data.timeZone) await setOwnerTimeZone(workspace.id, parsed.data.timeZone);
  redirect("/settings/morning-email?done=saved");
}

/** Check 44 P5: "Use Central time" — a deliberate tap to take this phone's zone. */
export async function takePhoneZoneAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const tz = formData.get("timeZone");
  if (!isTimeZone(tz)) redirect("/settings/morning-email?error=zone");
  await setOwnerTimeZone(workspace.id, tz);
  redirect("/settings/morning-email?done=zone");
}

/**
 * Check 45 P1: the browser's zone from the first signed-in page load (ZoneCapture). Saves only
 * while the zone was never set; anything else (a bad zone, a browser or owner zone) is ignored.
 */
export async function saveDetectedTimeZoneAction(timeZone: unknown): Promise<void> {
  const { workspace } = await requireOwner();
  await saveDetectedTimeZone(workspace.id, timeZone);
}

/** Trial emails on or off (2026-10-16). Off is the same flag as the emails' "Stop these emails". */
export async function saveTrialEmailsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  if (formData.get("trialEmails") === "on") await resumeTrialEmails(workspace.id);
  else await stopTrialEmails(workspace.id, "settings");
  redirect("/settings/morning-email?done=saved");
}

/** Turning autopilot on is re-checked server-side (plan, setup done, earned); off always works. */
export async function setAutopilotAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const category = String(formData.get("category") ?? "");
  const on = formData.get("on") === "1";
  try {
    await setAutopilot(workspace, category, on);
  } catch (err) {
    if (err instanceof AutopilotNotAllowedError) redirect("/settings/autopilot?error=autopilot");
    throw err;
  }
  redirect(on ? "/settings/autopilot?done=autopilot_on" : "/settings/autopilot?done=autopilot_off");
}

/** Plan #21: the owner's yes or no to an idea from their edits. */
export async function decideVoiceIdeaAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = z.string().uuid().safeParse(formData.get("ideaId"));
  if (!id.success) redirect("/settings/writing?error=unknown");
  const r = await decideSuggestion(workspace.id, id.data, formData.get("answer") === "yes");
  if (r === "type_it") redirect("/settings/voice");
  redirect(
    r === "accepted"
      ? "/settings/writing?done=idea_yes"
      : r === "ignored"
        ? "/settings/writing?done=idea_no"
        : "/settings/writing?error=unknown",
  );
}
