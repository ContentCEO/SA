"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { NOTE_MAX_CHARS, removeNote, saveNote } from "@/server/customer-notes";
import { ReadOnlyError } from "@/server/lifecycle";
import { requireOwner } from "@/server/session";

const key = z.string().uuid();

/** Ideas G7: "Save note". Posts the customer page's key (an email id), never an address. */
export async function saveNoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const k = key.safeParse(formData.get("key"));
  if (!k.success) redirect("/customers");
  const body = z
    .string()
    .max(NOTE_MAX_CHARS * 2)
    .safeParse(formData.get("note") ?? "");
  const back = (q: string) => `/customers/${k.data}?${q}#note`;
  if (!body.success) redirect(back(`error=too_long`));
  let r;
  try {
    r = await saveNote(workspace.id, k.data, body.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect(back(`error=readonly`));
    console.error("customer_note_failed", {
      workspaceId: workspace.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    redirect(back(`error=unknown`));
  }
  redirect(r === "saved" ? back(`done=note_saved`) : back(`error=${r}`));
}

/** "Remove note", after its confirm. */
export async function removeNoteAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const k = key.safeParse(formData.get("key"));
  if (!k.success) redirect("/customers");
  const back = (q: string) => `/customers/${k.data}?${q}#note`;
  let ok = false;
  try {
    ok = await removeNote(workspace.id, k.data);
  } catch (err) {
    if (err instanceof ReadOnlyError) redirect(back(`error=readonly`));
    throw err;
  }
  redirect(ok ? back(`done=note_removed`) : back(`error=unknown`));
}
