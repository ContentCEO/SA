import type { Metadata } from "next";
import Link from "next/link";
import { DisconnectButton } from "@/components/app/disconnect-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { mailboxHealth } from "@/server/mailbox-health";
import { planPausedLine } from "@/server/mailbox-plan-rules";
import {
  firstReadProgress,
  listMailboxes,
  mailboxLimit,
  type MailboxSummary,
} from "@/server/mailboxes";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { BACKFILL_DAYS, syncSummary } from "@/server/sync";
import { mailboxLimitFor } from "@/config/pricing";
import {
  addInboxFreeMonthNote,
  effectivePlan,
  freeMonthRunning,
  pausedInboxCopy,
} from "@/server/referral-rules";
import { disconnectMailboxAction, swapMailboxAction } from "../actions";
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
    return `Reading your last ${BACKFILL_DAYS} days of email. This can take a while.`;
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
  // Plan #47: the plan that counts (a free month's while it runs) decides the limit.
  const planNow = effectivePlan(workspace, now);
  const limit = mailboxLimit(workspace, now);
  // Check 25 P6: a first read in progress shows how far it got and when it started.
  const timeZone = (await getBusinessProfile(workspace.id))?.timeZone ?? "America/New_York";
  const firstReads = new Map(
    await Promise.all(
      mailboxes
        .filter((m) => !m.backfillCompletedAt)
        .map(
          async (m) =>
            [
              m.id,
              await firstReadProgress(
                { ...m, workspaceId: workspace.id },
                counts.get(m.id) ?? 0,
                timeZone,
              ),
            ] as const,
        ),
    ),
  );
  const canAddMore = mailboxes.length < limit;
  // A lower plan pauses the Gmail addresses it doesn't cover (2026-10-16); the owner picks.
  const onNow = mailboxes.filter((m) => !m.planPausedAt);
  const roomOnPlan = onNow.length < limit;
  const moreOnPlan = pausedInboxCopy(planNow).more;
  const freeMonth =
    freeMonthRunning(workspace, now) && workspace.freePlan && workspace.freePlanUntil
      ? { free: workspace.freePlan, until: workspace.freePlanUntil }
      : null;
  const addInboxNote =
    freeMonth &&
    canAddMore &&
    workspace.plan !== freeMonth.free &&
    mailboxes.length >= mailboxLimitFor(workspace.plan)
      ? addInboxFreeMonthNote(
          freeMonth.free,
          freeMonth.until,
          (await getBusinessProfile(workspace.id))?.timeZone,
        )
      : null;

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
              if (m.planPausedAt) {
                return (
                  <li
                    key={m.id}
                    aria-labelledby={`paused-${m.id}`}
                    className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
                  >
                    <div className="flex flex-col">
                      <span id={`paused-${m.id}`} className="text-lg font-semibold break-all">
                        {m.email}
                      </span>
                      <span className="font-black">{planPausedLine(limit)}</span>
                      <span className="mt-1 text-muted-foreground">
                        Nothing in it is read, sorted or drafted, and its drafts can&apos;t be sent
                        from here. Everything already here is kept.
                      </span>
                    </div>
                    {roomOnPlan ? (
                      <form action={swapMailboxAction}>
                        <input type="hidden" name="mailboxId" value={m.id} />
                        <Button type="submit" className="w-full">
                          Use this one instead
                        </Button>
                      </form>
                    ) : onNow.length === 1 ? (
                      <form action={swapMailboxAction} className="flex flex-col gap-1">
                        <input type="hidden" name="mailboxId" value={m.id} />
                        <input type="hidden" name="replaceId" value={onNow[0]!.id} />
                        <Button type="submit" className="w-full">
                          Use this one instead
                        </Button>
                        <span className="text-sm break-all text-muted-foreground">
                          {onNow[0]!.email} is paused in its place.
                        </span>
                      </form>
                    ) : (
                      <details className="rounded-lg border">
                        <summary className="flex min-h-tap cursor-pointer list-none items-center px-3 font-semibold underline underline-offset-4">
                          Use this one instead
                        </summary>
                        <div className="flex flex-col gap-2 px-3 pb-3">
                          <p className="text-sm text-muted-foreground">Which one should pause?</p>
                          {onNow.map((o) => (
                            <form key={o.id} action={swapMailboxAction}>
                              <input type="hidden" name="mailboxId" value={m.id} />
                              <input type="hidden" name="replaceId" value={o.id} />
                              <Button
                                type="submit"
                                variant="outline"
                                className="h-auto min-h-tap w-full py-2 break-all whitespace-normal"
                              >
                                Pause {o.email}
                              </Button>
                            </form>
                          ))}
                        </div>
                      </details>
                    )}
                    {moreOnPlan ? (
                      <Link
                        href="/billing"
                        className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
                      >
                        {moreOnPlan}
                      </Link>
                    ) : null}
                    <DisconnectButton
                      mailboxId={m.id}
                      email={m.email}
                      action={disconnectMailboxAction}
                    />
                  </li>
                );
              }
              const health = mailboxHealth(
                m,
                now,
                Boolean(process.env.GMAIL_PUBSUB_TOPIC),
                firstReads.get(m.id),
              );
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
                    <Link
                      href={`/connect?reconnect=${m.id}`}
                      className={cn(buttonVariants({ size: "lg" }), "w-full")}
                    >
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
          <div className="flex flex-col gap-1">
            <Link
              href="/connect?add=1"
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              Connect another Gmail
            </Link>
            {addInboxNote ? <p className="text-muted-foreground">{addInboxNote}</p> : null}
          </div>
        ) : null}
      </section>
    </SettingsScreen>
  );
}
