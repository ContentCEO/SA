import Link from "next/link";
import { signOut } from "@/auth";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button, buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { listMailboxes, mailboxLimit, type MailboxSummary } from "@/server/mailboxes";
import { BACKFILL_DAYS, syncSummary } from "@/server/sync";
import { requireOwner } from "@/server/session";
import { cn } from "@/lib/utils";
import { DisconnectButton } from "./disconnect-button";

const done: Record<string, string> = {
  connected: "Gmail connected.",
  disconnected: "Gmail disconnected. We've removed our access at Google.",
};

const errors: Record<string, string> = {
  limit: "Your plan is at its mailbox limit. Disconnect one first, or ask about a bigger plan.",
  unknown: "That didn't work. Refresh and try again.",
};

const statusWords = {
  active: "Connected",
  reconnect_needed: "Needs reconnecting",
  paused: "Paused",
} as const;

function syncLine(m: MailboxSummary, messageCount: number): string {
  if (m.status === "reconnect_needed") {
    return "Google access was removed, so Squared Away has stopped reading this inbox. Reconnect to pick up where it left off.";
  }
  if (m.status === "paused") return "Paused. Nothing is being read or drafted.";
  if (!m.backfillCompletedAt) {
    return `Reading your last ${BACKFILL_DAYS} days of email. This can take a few minutes.`;
  }
  const checked = m.lastSyncedAt ? `, checked ${relativeTime(m.lastSyncedAt)}` : "";
  return `${messageCount.toLocaleString("en-US")} emails from the last ${BACKFILL_DAYS} days${checked}.`;
}

export default async function SettingsPage(props: PageProps<"/settings">) {
  const { workspace } = await requireOwner();
  const mailboxes = await listMailboxes(workspace.id);
  const counts = new Map(
    await Promise.all(
      mailboxes.map(async (m) => [m.id, (await syncSummary(m.id)).messageCount] as const),
    ),
  );
  const params = await props.searchParams;
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const canAddMore = mailboxes.length < mailboxLimit(workspace);

  return (
    <>
      <Headline serif="your shop," heavy="your settings." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section aria-labelledby="mailbox" className="flex flex-col gap-4">
        <h2 id="mailbox" className="text-xl font-black">
          Connected mailbox
        </h2>

        {mailboxes.length === 0 ? (
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <p className="text-lg">No Gmail connected yet.</p>
            <Link href="/connect" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
              Connect Gmail
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {mailboxes.map((m) => {
              const needsYou = m.status === "reconnect_needed";
              return (
                <li
                  key={m.id}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border p-4",
                    needsYou ? "sa-inverted" : "bg-card",
                  )}
                >
                  <div className="flex flex-col">
                    <span className="text-lg font-semibold break-all">{m.email}</span>
                    <span className={cn(needsYou ? "font-black" : "text-muted-foreground")}>
                      {statusWords[m.status]}
                    </span>
                    <span className={cn("mt-1", needsYou ? "" : "text-muted-foreground")}>
                      {syncLine(m, counts.get(m.id) ?? 0)}
                    </span>
                  </div>
                  {needsYou ? (
                    <Link href="/connect" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
                      Reconnect Gmail
                    </Link>
                  ) : null}
                  <DisconnectButton mailboxId={m.id} email={m.email} />
                </li>
              );
            })}
          </ul>
        )}

        {mailboxes.length > 0 && canAddMore ? (
          <Link
            href="/connect"
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            Connect another Gmail
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="text-xl font-black">
          Account
        </h2>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </section>
    </>
  );
}
