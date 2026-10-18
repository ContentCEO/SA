import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { jobsAllowed } from "@/server/lifecycle";
import { staleMailLine, syncIsStale } from "@/server/mailbox-health";
import { mailboxOn } from "@/server/mailbox-plan-rules";
import { listMailboxes } from "@/server/mailboxes";

/**
 * Check 25 P6: when mail checking is behind, say so on every signed-in screen in one plain
 * line — a quiet Queue must never look the same as a stuck one. Only for accounts we still
 * read (a read-only account isn't checked on purpose; its banner says why), and only for an
 * inbox that's on and already read once (lost access has its own banner).
 */
export async function StaleMailLine({ now = new Date() }: { now?: Date } = {}) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const workspace = await getWorkspaceForUser(session.user.id);
  if (!workspace || !jobsAllowed(workspace, now)) return null;
  const stale = (await listMailboxes(workspace.id))
    .filter((m) => m.status === "active" && mailboxOn(m) && syncIsStale(m, now))
    .sort((a, b) => (a.lastSyncedAt?.getTime() ?? 0) - (b.lastSyncedAt?.getTime() ?? 0));
  const oldest = stale[0];
  if (!oldest) return null;
  return (
    <p role="status" className="sa-inverted rounded-lg px-4 py-3 text-base font-semibold">
      {staleMailLine(oldest.lastSyncedAt, now)}
    </p>
  );
}
