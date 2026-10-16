import type { Metadata } from "next";
import Link from "next/link";
import { DisconnectButton } from "@/components/app/disconnect-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { mailboxHealth } from "@/server/mailbox-health";
import { listMailboxes, mailboxLimit, type MailboxSummary } from "@/server/mailboxes";
import { requireOwner } from "@/server/session";
import { BACKFILL_DAYS, syncSummary } from "@/server/sync";
import { mailboxLimitFor, type PlanId } from "@/config/pricing";
import {
  addInboxFreeMonthNote,
  effectivePlan,
  freeMonthRunning,
  pausedInboxCopy,
  reconnectRefusedLine,
} from "@/server/referral-rules";
import { getBusinessProfile } from "@/server/profile";
import { disconnectMailboxAction, swapInboxAction } from "../actions";
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
  const params = await props.searchParams;
  // Plan #47: the plan that counts (a free month's while it runs) decides the inbox limit;
  // inboxes paused for being over it don't count.
  const planNow = effectivePlan(workspace, now);
  const counted = mailboxes.filter((m) => m.pausedReason == null);
  const canAddMore = counted.length < mailboxLimit(workspace, now);
  const freeMonth =
    freeMonthRunning(workspace, now) && workspace.freePlan && workspace.freePlanUntil
      ? { free: workspace.freePlan, until: workspace.freePlanUntil }
      : null;
  const addInboxNote =
    freeMonth &&
    canAddMore &&
    workspace.plan !== freeMonth.free &&
    counted.length >= mailboxLimitFor(workspace.plan)
      ? addInboxFreeMonthNote(
          freeMonth.free,
          freeMonth.until,
          (await getBusinessProfile(workspace.id))?.timeZone,
        )
      : null;

  return (
    <SettingsScreen
      path="/settings/gmail"
      heavy="your gmail."
      params={params}
      errorText={params.error === "paused_limit" ? reconnectRefusedLine(planNow) : undefined}
    >
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
                      {m.pausedReason === "over_plan"
                        ? pausedInboxCopy(planNow).line
                        : syncLine(m, counts.get(m.id) ?? 0)}
                    </span>
                  </div>
                  {m.pausedReason === "over_plan" ? (
                    <SwapInbox paused={m} counted={counted} plan={planNow} />
                  ) : null}
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
          <div className="flex flex-col gap-1">
            <Link
              href="/connect"
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

/**
 * Plan #47: an inbox paused for being over the plan. The owner can switch it on instead of one
 * that's on (newest preselected); the plan's limit holds. Or move up a plan.
 */
function SwapInbox({
  paused,
  counted,
  plan,
}: {
  paused: MailboxSummary;
  counted: MailboxSummary[];
  plan: PlanId | null;
}) {
  const copy = pausedInboxCopy(plan);
  const newest = counted[counted.length - 1];
  return (
    <div className="flex flex-col gap-2">
      {newest ? (
        <details className="group flex flex-col gap-2">
          <summary
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "w-full cursor-pointer list-none",
            )}
          >
            {copy.button}
          </summary>
          <form action={swapInboxAction} className="mt-2 flex flex-col gap-3">
            <input type="hidden" name="resumeId" value={paused.id} />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-semibold">Which inbox should pause instead?</legend>
              {counted.map((c) => (
                <label key={c.id} className="flex min-h-tap items-center gap-3 break-all">
                  <input
                    type="radio"
                    name="pauseId"
                    value={c.id}
                    defaultChecked={c.id === newest.id}
                    className="size-5 shrink-0"
                  />
                  {c.email}
                </label>
              ))}
            </fieldset>
            <Button type="submit" size="lg" className="w-full">
              Switch inboxes
            </Button>
          </form>
        </details>
      ) : null}
      {copy.more ? (
        <p className="text-muted-foreground">
          Or{" "}
          <Link href="/billing" className="font-semibold underline underline-offset-4">
            {copy.more.replace(/^or /, "")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
