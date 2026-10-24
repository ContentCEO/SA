import Link from "next/link";
import { auth } from "@/auth";
import { getWorkspaceForUser } from "@/server/accounts";
import { listMailboxes } from "@/server/mailboxes";

/** Never fail silently: if Google access is gone, say so on every screen. */
export async function ReconnectBanner() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const workspace = await getWorkspaceForUser(session.user.id);
  if (!workspace) return null;
  // A Gmail address paused on the plan isn't read anyway; Settings → Your Gmail explains it.
  const broken = (await listMailboxes(workspace.id)).filter(
    (m) => m.status === "reconnect_needed" && !m.planPausedAt,
  );
  if (broken.length === 0) return null;
  return (
    <div role="alert" className="sa-inverted flex flex-col gap-3 rounded-xl p-4">
      <p className="text-base font-semibold">
        Squared Away lost access to {broken.map((m) => m.email).join(", ")}. Nothing is being read
        or drafted until you reconnect.
      </p>
      <Link
        href={broken.length === 1 ? `/connect?reconnect=${broken[0]!.id}` : "/connect"}
        className="inline-flex min-h-tap items-center justify-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground"
      >
        {/* Plan #49: an Outlook-only loss says Outlook (only possible with FEATURE_OUTLOOK). */}
        {broken.every((m) => m.provider === "outlook") ? "Reconnect Outlook" : "Reconnect Gmail"}
      </Link>
    </div>
  );
}
