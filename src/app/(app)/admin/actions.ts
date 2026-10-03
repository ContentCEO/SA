"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { planEnum, tradeEnum } from "@/db/schema";
import { inviteOwner } from "@/server/admin";
import { requireAdmin } from "@/server/session";
import { isAdminMove } from "@/server/lifecycle";
import {
  applyAdminMove,
  MoveNotAllowedError,
  setWorkspacePlan,
} from "@/server/workspace-lifecycle";

const id = z.string().uuid();

/** Davi's manual status moves. Re-checks admin on every call, not just the page. */
export async function adminMoveAction(formData: FormData) {
  await requireAdmin();
  const workspaceId = id.safeParse(formData.get("workspaceId"));
  const move = formData.get("move");
  if (!workspaceId.success || !isAdminMove(move)) redirect("/admin?error=unknown");
  try {
    await applyAdminMove(workspaceId.data, move);
  } catch (err) {
    if (err instanceof MoveNotAllowedError) redirect("/admin?error=move");
    throw err;
  }
  redirect(`/admin?done=${move}`);
}

const invite = z.object({
  email: z.string().trim().toLowerCase().email(),
  trade: z.enum(tradeEnum.enumValues).nullable(),
  note: z.string().trim().max(500).nullable(),
});

export async function inviteAction(formData: FormData) {
  await requireAdmin();
  const parsed = invite.safeParse({
    email: formData.get("email"),
    trade: formData.get("trade") || null,
    note: formData.get("note") || null,
  });
  if (!parsed.success) redirect("/admin?error=invite");
  const r = await inviteOwner(parsed.data);
  redirect(`/admin?done=${r}`);
}

const plan = z.enum(planEnum.enumValues).nullable();

export async function setPlanAction(formData: FormData) {
  await requireAdmin();
  const workspaceId = id.safeParse(formData.get("workspaceId"));
  const chosen = plan.safeParse(formData.get("plan") || null);
  if (!workspaceId.success || !chosen.success) redirect("/admin?error=unknown");
  await setWorkspacePlan(workspaceId.data, chosen.data);
  redirect("/admin?done=plan");
}
