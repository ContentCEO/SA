import type { Metadata } from "next";
import Link from "next/link";
import { DisconnectButton } from "@/components/app/disconnect-button";
import { buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { mailboxHealth } from "@/server/mailbox-health";
import { listMailboxes, mailboxLimit, type MailboxSummary } from "@/server/mailboxes";
import { requireOwner } from "@/server/session";
import { BACKFILL_DAYS, syncSummary } from "@/server/sync";
import { disconnectMailboxAction } from "../actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Your Gmail" };

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

export default async function GmailSettingsPage(props: PageProps<"/settings/gmail">) {
  const { workspace } = await requireOwner();
  const now = new Date();
  const mailboxes = await listMailboxes(workspace.id);
  const counts = new Map(
    await Promise.all(
      mailboxes.map(async (m) => [m.id, (await syncSummary(m.id)).messageCount] as const),
    ),
  );
  const canAddMore = mailboxes.length < mailboxLimit(workspace);

  return (
    <SettingsScreen path="/settings/gmail" heavy="your gmail." params={await props.searchParams}>
      <section aria-labelledby="mailbox" className="flex flex-col gap-4">
        <h2 id="mailbox" className="sr-only">
          Your Gmail
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
              const health = mailboxHealth(m, now, Boolean(process.env.GMAIL_PUBSUB_TOPIC));
              const needsYou = health.needsReconnect;
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
                  <dl aria-label={`Health of ${m.email}`} className="flex flex-col gap-1.5">
                    {health.lines.map((l) => (
                      <div key={l.label} className="flex flex-col">
                        <dt className="text-sm opacity-80">{l.label}</dt>
                        <dd className={l.problem ? "font-black" : undefined}>{l.text}</dd>
                      </div>
                    ))}
                  </dl>
                  {needsYou ? (
                    <Link href="/connect" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
                      Reconnect Gmail
                    </Link>
                  ) : null}
                  <DisconnectButton
                    mailboxId={m.id}
                    email={m.email}
                    action={disconnectMailboxAction}
                  />
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
    </SettingsScreen>
  );
}
