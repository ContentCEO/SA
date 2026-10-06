import type { Metadata } from "next";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { tradeEnum } from "@/db/schema";
import { relativeTime } from "@/lib/relative-time";
import {
  ADMIN_PAGE_SIZE,
  adminOverview,
  countWorkspaces,
  listInvites,
  type AdminRow,
} from "@/server/admin";
import { requireAdmin } from "@/server/session";
import { ADMIN_MOVES, canMakeMove, type AdminMove } from "@/server/lifecycle";
import {
  adminMoveAction,
  connectStripeAction,
  inviteAction,
  inviteFromWaitlistAction,
  setPlanAction,
} from "./actions";
import { PendingButton } from "@/components/app/pending-button";
import { stripeConfigured, stripeConnectedAt } from "@/server/billing";
import { listWaitlist } from "@/server/waitlist";
import { pricing } from "@/config/pricing";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

const statusLabel: Record<AdminRow["status"], string> = {
  invited: "Invited",
  evaluating: "Evaluating",
  evaluation_expired: "Evaluation over",
  setup_paid: "Setup paid",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  paused: "Paused",
};

const moves: Record<AdminMove, { label: string; explain: string; confirm: string }> = {
  extend_evaluation: {
    label: "Give 3 more days",
    explain: "Restarts drafting if it had stopped. Sending stays off.",
    confirm: "Add 3 days",
  },
  mark_setup_paid: {
    label: "Mark setup paid",
    explain: "Turns sending on for this owner. Every reply still needs their tap.",
    confirm: "Yes, setup is paid",
  },
  mark_setup_call_done: {
    label: "Setup call done",
    explain: "Moves them to Active.",
    confirm: "Yes, make active",
  },
  pause: {
    label: "Pause account",
    explain: "Stops reading, drafting and sending. Nothing is deleted.",
    confirm: "Yes, pause",
  },
  resume: {
    label: "Resume account",
    explain: "Puts them back where they were before the pause.",
    confirm: "Yes, resume",
  },
};

const done: Record<string, string> = {
  extend_evaluation: "Three more days added.",
  mark_setup_paid: "Marked setup paid. Sending is on for them.",
  mark_setup_call_done: "Marked active.",
  pause: "Account paused.",
  resume: "Account resumed.",
  plan: "Plan saved.",
  stripe_test:
    "Stripe connected in TEST mode: prices, billing portal and payment notifications are set up. Use card 4242 4242 4242 4242 to try it.",
  stripe_live: "Stripe connected in LIVE mode. Real cards will be charged.",
  invited: "Invited. They can sign in now (add them as a Google test user too).",
  already_invited: "That address was already invited.",
};
const errors: Record<string, string> = {
  stripe: "Couldn't connect Stripe. Check the STRIPE_SECRET_KEY in Vercel, then try again.",
  move: "That change isn't allowed from the account's current status. Refresh and look again.",
  invite: "That doesn't look like an email address.",
  unknown: "That didn't work. Refresh and try again.",
};

const et = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function WorkspaceCard({ w, now }: { w: AdminRow; now: Date }) {
  const allowed = (Object.keys(ADMIN_MOVES) as AdminMove[]).filter((m) =>
    canMakeMove(m, { status: w.status, evaluationEndsAt: w.evaluationEndsAt }, now),
  );
  const inverted = ["evaluation_expired", "past_due", "paused", "canceled"].includes(w.status);
  return (
    <article
      aria-label={w.ownerEmail}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-lg font-black">{w.businessName || w.ownerEmail}</span>
          {w.businessName ? <span className="truncate text-sm">{w.ownerEmail}</span> : null}
        </div>
        <span
          className={
            inverted
              ? "sa-inverted rounded-md px-2 py-1 text-sm font-black"
              : "rounded-md border-2 border-charcoal px-2 py-1 text-sm font-black"
          }
        >
          {statusLabel[w.status]}
        </span>
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Stat label="Trade" value={w.trade ? w.trade[0]!.toUpperCase() + w.trade.slice(1) : "—"} />
        <Stat label="Plan" value={w.plan ?? "None yet"} />
        <Stat
          label={
            !w.evaluationEndsAt
              ? "Evaluation"
              : w.status === "evaluating"
                ? "Evaluation ends"
                : "Evaluation ended"
          }
          value={w.evaluationEndsAt ? et.format(w.evaluationEndsAt) : "Not started"}
        />
        <Stat
          label="Mailboxes"
          value={
            w.mailboxes.total === 0
              ? "None connected"
              : `${w.mailboxes.total}${w.mailboxes.needReconnect ? `, ${w.mailboxes.needReconnect} need reconnect` : ", healthy"}`
          }
        />
        <Stat
          label="Last sync"
          value={w.mailboxes.lastSyncedAt ? relativeTime(w.mailboxes.lastSyncedAt, now) : "Never"}
        />
        <Stat label="Drafts waiting" value={w.drafts.pending} />
        <Stat label="Sent (7 days)" value={w.drafts.sentLast7Days} />
        <Stat label="Drafts this month" value={w.drafts.createdThisMonth} />
        <Stat label="AI calls today" value={w.ai.callsToday} />
        <Stat label="AI cost this month" value={`${dollars(w.ai.costCentsThisMonth)} (est.)`} />
      </dl>
      <form action={setPlanAction} className="flex gap-2">
        <input type="hidden" name="workspaceId" value={w.workspaceId} />
        <label className="flex flex-1 flex-col gap-1">
          <span className="sr-only">Plan</span>
          <select
            name="plan"
            aria-label="Plan"
            defaultValue={w.plan ?? ""}
            className="min-h-tap w-full rounded-lg border border-input bg-paper px-3 text-base"
          >
            <option value="">No plan yet</option>
            {Object.entries(pricing.plans).map(([id, p]) => (
              <option key={id} value={id}>
                {p.name}
                {p.autopilot ? " (autopilot)" : ""}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline">
          Save plan
        </Button>
      </form>
      {allowed.length ? (
        <div className="flex flex-col gap-2">
          {allowed.map((m) => (
            <details key={m} className="rounded-lg border">
              <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
                {moves[m].label}
              </summary>
              <form action={adminMoveAction} className="flex flex-col gap-2 px-4 pb-4">
                <input type="hidden" name="workspaceId" value={w.workspaceId} />
                <input type="hidden" name="move" value={m} />
                <p>{moves[m].explain}</p>
                <Button type="submit" className="w-full">
                  {moves[m].confirm}
                </Button>
              </form>
            </details>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default async function AdminPage(props: PageProps<"/admin">) {
  await requireAdmin();
  const params = await props.searchParams;
  const now = new Date();
  const [rows, total, invited, waiting, stripeAt] = await Promise.all([
    adminOverview(now),
    countWorkspaces(),
    listInvites(),
    listWaitlist(),
    stripeConnectedAt(),
  ]);
  // Payment messages show inside the Payments section (the page scrolls there), not at the top.
  const isStripe = (k: unknown) => typeof k === "string" && k.startsWith("stripe");
  const doneMsg =
    typeof params.done === "string" && !isStripe(params.done) ? done[params.done] : undefined;
  const errorMsg =
    typeof params.error === "string" && !isStripe(params.error) ? errors[params.error] : undefined;
  const stripeDone = isStripe(params.done) ? done[params.done as string] : undefined;
  const stripeError = isStripe(params.error) ? errors[params.error as string] : undefined;
  const stripeReason = typeof params.reason === "string" ? params.reason.slice(0, 200) : null;

  return (
    <>
      <Headline serif="behind the counter," heavy="admin." />
      <p className="text-muted-foreground">
        Health and money only. No email content or customer names are shown here.
      </p>
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section aria-labelledby="accounts" className="flex flex-col gap-3">
        <h2 id="accounts" className="text-xl font-black">
          Accounts ({total})
        </h2>
        {total > rows.length ? (
          <p className="text-muted-foreground">Showing the newest {ADMIN_PAGE_SIZE}.</p>
        ) : null}
        {rows.length === 0 ? <p>No one has signed in yet.</p> : null}
        {rows.map((w) => (
          <WorkspaceCard key={w.workspaceId} w={w} now={now} />
        ))}
      </section>

      <section id="stripe" aria-labelledby="stripe-heading" className="flex flex-col gap-3">
        <h2 id="stripe-heading" className="text-xl font-black">
          Payments
        </h2>
        {stripeDone ? <Notice>{stripeDone}</Notice> : null}
        {stripeError ? (
          <Notice strong>
            {stripeError}
            {stripeReason ? ` Stripe said: “${stripeReason}”` : null}
          </Notice>
        ) : null}
        {stripeConfigured() ? (
          <form action={connectStripeAction} className="flex flex-col gap-2">
            <p className="font-semibold">
              {stripeAt ? `Connected · last set up ${et.format(stripeAt)}` : "Not connected yet."}
            </p>
            <p>
              Sets up the four prices from the price list, the customer billing page, and the
              payment notifications that switch accounts on and off. Takes about 10 seconds. Safe to
              tap again.
            </p>
            <PendingButton pending="Connecting to Stripe…" className="w-full">
              {stripeAt ? "Connect Stripe again" : "Connect Stripe"}
            </PendingButton>
          </form>
        ) : (
          <p>Add STRIPE_SECRET_KEY to the sa project in Vercel first.</p>
        )}
      </section>

      <section id="waitlist" aria-labelledby="waitlist-heading" className="flex flex-col gap-3">
        <h2 id="waitlist-heading" className="text-xl font-black">
          Waitlist ({waiting.length})
        </h2>
        {waiting.length === 0 ? (
          <p>Nobody yet. The form is on the public home page.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {waiting.map((w) => (
              <li
                key={w.email}
                aria-label={`Waitlist: ${w.email}`}
                className="flex flex-col gap-2 rounded-xl border bg-card p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-lg font-black">{w.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {relativeTime(w.createdAt, now)}
                  </span>
                </div>
                <span className="break-all">{w.email}</span>
                <span className="text-sm">
                  {[w.trade, w.teamSize ? `${w.teamSize} people` : null, w.phone]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {w.note ? <p className="text-muted-foreground">“{w.note}”</p> : null}
                {w.invitedAt ? (
                  <span className="font-semibold">Invited {relativeTime(w.invitedAt, now)}</span>
                ) : (
                  <form action={inviteFromWaitlistAction}>
                    <input type="hidden" name="email" value={w.email} />
                    <Button type="submit" className="w-full">
                      Invite {w.name.split(" ")[0]}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="invite" className="flex flex-col gap-3">
        <h2 id="invite" className="text-xl font-black">
          Invite an owner
        </h2>
        <form action={inviteAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Their Gmail address</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="off"
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Trade</span>
            <select
              name="trade"
              defaultValue=""
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            >
              <option value="">Not sure</option>
              {tradeEnum.enumValues.map((t) => (
                <option key={t} value={t}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Note (optional)</span>
            <input
              name="note"
              maxLength={500}
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            />
          </label>
          <Button type="submit" className="w-full">
            Add to invite list
          </Button>
          <p className="text-sm text-muted-foreground">
            This lets them sign in. It doesn&apos;t email them — tell them yourself. Until Google
            approves the app, also add them as a test user in Google Cloud.
          </p>
        </form>
        {invited.length ? (
          <ul className="flex flex-col divide-y rounded-lg border">
            {invited.map((i) => (
              <li key={i.email} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <span className="truncate">{i.email}</span>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {i.acceptedAt ? "Signed in" : "Not yet"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
