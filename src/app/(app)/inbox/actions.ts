"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { markNeedsOwner } from "@/server/classification";
import { requireOwner } from "@/server/session";

const input = z.object({ threadId: z.string().uuid() });

export async function markNeedsOwnerAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const parsed = input.safeParse({ threadId: formData.get("threadId") });
  if (!parsed.success) return;
  await markNeedsOwner(workspace.id, parsed.data.threadId);
  revalidatePath("/inbox");
}
