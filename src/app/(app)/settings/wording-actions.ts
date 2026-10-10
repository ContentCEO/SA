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
  await saveNeverSay(workspace.id, text);
  redirect("/settings?done=never_say#never-say");
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
  revalidatePath("/settings");
  return { ok: true, message: "Added. Future drafts won't say it." };
}

export async function addSeasonalNoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = seasonalNoteInput.safeParse({
    text: formData.get("text") ?? "",
    endsOn: formData.get("endsOn") ?? "",
  });
  if (!parsed.success) redirect("/settings?error=note_invalid#seasonal-notes");
  try {
    await addSeasonalNote(workspace.id, parsed.data);
  } catch (err) {
    if (err instanceof SeasonalNoteError) {
      redirect(`/settings?error=note_${err.code}#seasonal-notes`);
    }
    throw err;
  }
  redirect("/settings?done=note_added#seasonal-notes");
}

export async function removeSeasonalNoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/settings?error=unknown");
  await removeSeasonalNote(workspace.id, id.data);
  redirect("/settings?done=note_removed#seasonal-notes");
}
