"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { addNeverSay, NeverSayError, saveNeverSay } from "@/server/never-say";
import {
  addSeasonalNote,
  removeSeasonalNote,
  SeasonalNoteError,
  seasonalNoteInput,
} from "@/server/seasonal-notes";
import { requireOwner } from "@/server/session";

/** Settings → Never say this (one phrase per line). */
export async function saveNeverSayAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const text = String(formData.get("neverSay") ?? "").slice(0, 10_000);
  const { saved, skipped } = await saveNeverSay(workspace.id, text);
  if (!skipped) redirect("/settings/writing?done=never_say");
  // Check 15 P5: the counts go as their own numbers, never the text.
  redirect("/settings/writing?done=never_say_skipped" + `&saved=${saved}&skipped=${skipped}`);
}

export type NeverSayResult = { ok: boolean; message: string };

/** From the draft editor: the selected words → the never-say list. Stays on the page. */
export async function addNeverSayAction(phrase: string): Promise<NeverSayResult> {
  const { workspace } = await requireOwner();
  try {
    await addNeverSay(workspace.id, String(phrase ?? ""));
  } catch (err) {
    if (err instanceof NeverSayError) return { ok: false, message: err.message };
    throw err;
  }
  revalidatePath("/settings/writing");
  return { ok: true, message: "Added. Future drafts won't say it." };
}

export type NoteFormState = {
  errors?: { text?: string[]; endsOn?: string[]; form?: string[] };
  values?: { text: string; endsOn: string };
};

/**
 * Check 15 P9: Settings → Your business → Add note. A refusal comes back with its own message
 * and what was typed (kept in the boxes); a saved note goes back to the screen.
 */
export async function addSeasonalNoteFormAction(
  _prev: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const { workspace } = await requireOwner();
  const values = {
    text: String(formData.get("text") ?? "").slice(0, 500),
    endsOn: String(formData.get("endsOn") ?? "").slice(0, 20),
  };
  const parsed = seasonalNoteInput.safeParse(values);
  if (!parsed.success) return { errors: z.flattenError(parsed.error).fieldErrors, values };
  try {
    await addSeasonalNote(workspace.id, parsed.data);
  } catch (err) {
    if (err instanceof SeasonalNoteError) {
      const where = err.code === "full" ? "form" : "endsOn";
      return { errors: { [where]: [err.message] }, values };
    }
    throw err;
  }
  redirect("/settings/business?done=note_added");
}

export async function removeSeasonalNoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/settings/business?error=unknown");
  await removeSeasonalNote(workspace.id, id.data);
  redirect("/settings/business?done=note_removed");
}
