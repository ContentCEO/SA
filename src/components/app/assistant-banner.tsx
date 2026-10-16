import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { assistantStatus } from "@/server/assistant-status";

/**
 * Review C6 / C7: when the daily assistant limit is (nearly) used up, or new mail is waiting
 * to be sorted, say so in plain words on every signed-in screen. Counts only.
 */
export async function AssistantBanner() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const workspace = await getWorkspaceForUser(session.user.id);
  if (!workspace) return null;
  const notice = await assistantStatus(workspace);
  if (!notice) return null;
  return (
    <section role="status" className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4">
      <p className="text-lg font-black">{notice.title}</p>
      <p>{notice.body}</p>
    </section>
  );
}
