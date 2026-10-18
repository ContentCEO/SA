import Link from "next/link";
import { describeSource } from "@/server/source-rules";
import type { Metadata } from "next";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { isTrade, tradeLabel } from "@/config/trades";
import { tradeEnum } from "@/db/schema";
import { relativeTime } from "@/lib/relative-time";
import {
  ADMIN_PAGE_SIZE,
  accountsNeedingYou,
  adminOverview,
  countInvites,
  countWorkspaces,
  pageNumber,
  listInvites,
  systemHealth,
  type AdminRow,
} from "@/server/admin";
import { requireAdmin } from "@/server/session";
import { mailboxesLine, mailboxesStuck, systemTroubleLines } from "@/server/admin-mailbox-rules";
import { modelDownLine, stoppedHeading } from "@/server/model-alert-rules";
import { modelsDownToday } from "@/server/model-alerts";
import { isAdminEmail } from "@/server/admin";
import { ADMIN_MOVES, canMakeMove, type AdminMove } from "@/server/lifecycle";
import {
  cardNotice,
  needsYou,
  NOTHING_NEEDS_YOU,
  ORPHAN_PLAN_LINE,
  PAUSE_EXPLAIN,
  PLAN_SET_BY_STRIPE_LINE,
  planName,
  pauseExplanation,
  STILL_BILLED_LINE,
  TWO_PLANS_LINE,
} from "@/server/admin-rules";
import {
  adminMoveAction,
  checkTestPaymentsAction,
  clearStripeOrphansAction,
  connectStripeAction,
  inviteAction,
  inviteFromWaitlistAction,
  removeInviteAction,
  testUserAddedAction,
  resetTestPaymentsAction,
  setPlanAction,
  tickLaunchAction,
} from "./actions";
import { LaunchReady } from "./launch-ready";
import { launchChecks } from "@/server/launch-ready";
import { loadLaunchFacts } from "@/server/launch-ticks";
import { PendingButton } from "@/components/app/pending-button";
import {
  salesTaxStatus,
  stripeConfigured,
  stripeConnectedAt,
  stripeMode,
  stripeOrphans,
  stripeWaitingWorkspaces,
  termsBoxOffSince,
} from "@/server/billing";
import { SALES_TAX_LINES, SALES_TAX_ON_NOTE, TERMS_BOX_OFF_LINE } from "@/server/billing-rules";
import { stripeReasonText } from "@/server/stripe-error-rules";
import {
  CHECKOUT_REVIEW_LINE,
  PAID_WAITING_LINE,
  stripeWaitingLine,
} from "@/server/billing-notice-rules";
import { moneyLines, openDisputesLine } from "@/server/stripe-money-rules";
import { openDisputeCount } from "@/server/stripe-money";
import { lastTestPaymentsResult } from "@/server/test-payments";
import {
  PAST_DUE_RESET_NOTE,
  TEST_PAYMENTS_TEST_MODE,
  testPaymentsLine,
  testPaymentsResetNotice,
} from "@/server/test-payment-rules";
import { listWaitlist } from "@/server/waitlist";
import { referralsVisible } from "@/server/referral-rules";
import { describeWaitlistEntry, formatStamp, localStamp } from "@/server/growth-note";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { phoneHref } from "@/lib/phone-href";
import { pricing } from "@/config/pricing";
import { adminToday, type GrowthStatus } from "@/server/growth-client-rules";
import { countGrowthClients, growthStateForEmails } from "@/server/growth-clients";
import {
  WAITLIST_GROWTH_DONE,
  WAITLIST_GROWTH_ERRORS,
  WaitlistGrowthControls,
} from "./growth-admin";

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
    label: `Give ${pricing.evaluationDays} more days`,
    explain: "Restarts drafting if it had stopped. Sending stays off.",
    confirm: `Add ${pricing.evaluationDays} days`,
  },
  house_account: {
    label: "Use as my own test account",
    explain:
      "Only for your own account: lets it send without paying, so you can test. Customers can only turn sending on by paying through Stripe.",
    confirm: "Yes, this is my account",
  },
  mark_setup_call_done: {
    label: "Setup call done",
    explain: "Moves them to Active.",
    confirm: "Yes, make active",
  },
  pause: {
    label: "Pause account",
    explain: PAUSE_EXPLAIN,
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
  house_account: "Your account can send now (marked as your own test account).",
  mark_setup_call_done: "Marked active.",
  pause: "Account paused.",
  resume: "Account resumed.",
  plan: "Plan saved.",
  launch_ticked: "Marked done.",
  stripe_test:
    "Stripe connected in TEST mode: prices, billing portal and payment notifications are set up. Use card 4242 4242 4242 4242 to try it.",
  stripe_live: "Stripe connected in LIVE mode. Real cards will be charged.",
  stripe_test_check: "Test payments checked.",
  stripe_orphans_cleared: "Cleared. It comes back if Stripe sends another one.",
  invited:
    "Invited. They can sign in now. The invite email didn't go out (email isn't set up, or it failed), so tell them yourself. Add them as a Google test user too.",
  invited_emailed:
    "Invited, and emailed them the sign-in link. Add them as a Google test user too (see the list under Invite an owner).",
  test_user: "Marked as a Google test user.",
  already_invited: "That address was already invited.",
  invite_removed: "Invite taken back. That address can't sign in now.",
  invite_gone: "That invite was already gone.",
};
/** Where Google Cloud lists an app's test users (Google Auth Platform → Audience). */
const GOOGLE_AUDIENCE_URL = "https://console.cloud.google.com/auth/audience";

const errors: Record<string, string> = {
  stripe: "Couldn't connect Stripe.",
  stripe_test_mode: TEST_PAYMENTS_TEST_MODE,
  stripe_test_payments: "Couldn't check test payments. Try again in a minute.",
  plan_stripe:
    "That account pays through Stripe, so its plan follows the subscription. Change it in Stripe.",
  move: "That change isn't allowed from the account's current status. Refresh and look again.",
  invite: "That doesn't look like an email address.",
  invite_used: "They've already signed in, so that invite can't be taken back.",
  growth_only: growthCopy.admin.growthOnlyError,
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

const ga = growthCopy.admin;
const CALLABLE = /^\d{3}-\d{3}-\d{4}$/;

/**
 * One waitlist row: an app sign-up, a Squared Away Growth call request, or both. The Growth
 * conventions are read only through describeWaitlistEntry. A Growth-only row is never invited.
 */
function WaitlistEntry({
  w,
  now,
  referrals,
  growth,
  today,
}: {
  w: Awaited<ReturnType<typeof listWaitlist>>[number];
  now: Date;
  /** Plan #47: referralsVisible(), so a stored code shows only while referrals are on. */
  referrals: boolean;
  /** Squared Away Growth: a Growth invite waiting, or already a client (by email). */
  growth: { invitedAt: Date | null; client: GrowthStatus | null } | undefined;
  today: string;
}) {
  const facts = describeWaitlistEntry(w);
  const request = facts.growth[0];
  const callLink = (phone: string | null) =>
    phone && CALLABLE.test(phone) ? (
      <a
        href={phoneHref("tel", phone)}
        className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
      >
        {ga.call(phone)}
      </a>
    ) : null;
  return (
    <li
      aria-label={`Waitlist: ${w.email}`}
      className="flex flex-col gap-2 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-lg font-black">{w.name}</span>
        <span className="text-sm text-muted-foreground">{relativeTime(w.createdAt, now)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {request ? (
          <span className="sa-inverted rounded px-2 py-0.5 text-sm font-black">
            {ga.growthChip}
          </span>
        ) : null}
        {facts.app ? (
          <span className="rounded border-2 border-charcoal px-2 py-0.5 text-sm font-black">
            {ga.appChip}
          </span>
        ) : null}
      </div>
      <span className="break-all">{w.email}</span>
      <span className="text-sm">
        {(facts.app
          ? [
              w.trade ? tradeLabel[w.trade] : null,
              w.teamSize ? `${w.teamSize} people` : null,
              w.phone,
            ]
          : [w.trade ? tradeLabel[w.trade] : null]
        )
          .filter(Boolean)
          .join(" · ")}
      </span>
      {facts.appNote ? <p className="text-muted-foreground">“{facts.appNote}”</p> : null}
      {describeSource(w) ? <span className="text-sm">Came from: {describeSource(w)}</span> : null}
      {referrals && facts.app && w.referralCode ? (
        <span className="text-sm font-semibold">Came from a referral link</span>
      ) : null}
      {request ? (
        <div className="flex flex-col gap-1 border-t border-stone pt-2">
          <span className="font-semibold">{ga.wants(request.services)}</span>
          <span className="text-sm">{ga.asked(formatStamp(request.at))}</span>
          {callLink(request.phone)}
          {request.nameGiven ? <span>{ga.nameGiven(request.nameGiven)}</span> : null}
          {request.tradeGiven ? <span>{ga.tradeGiven(request.tradeGiven)}</span> : null}
          {request.note ? <p className="text-muted-foreground">“{request.note}”</p> : null}
          <WaitlistGrowthControls
            email={w.email}
            trade={w.trade}
            growthOnly={!facts.app}
            request={request}
            state={growth}
            hasAccount={w.inviteState === "has_account"}
            today={today}
            now={now}
          />
        </div>
      ) : null}
      {!facts.app ? (
        <span className="font-semibold">{ga.growthOnly}</span>
      ) : w.inviteState === "invited" ? (
        <span className="font-semibold">
          Invited {relativeTime(w.inviteAt ?? w.invitedAt ?? w.createdAt, now)}
        </span>
      ) : w.inviteState === "has_account" ? (
        <span className="font-semibold">Has an account</span>
      ) : (
        <form action={inviteFromWaitlistAction} className="flex flex-col gap-2">
          {w.inviteState === "invite_gone" ? (
            // Delete my account removes the invite but keeps this entry.
            <span className="text-sm">
              Invited before, but that invite is gone (Delete my account removes it), so they
              can&apos;t sign in.
            </span>
          ) : null}
          <input type="hidden" name="email" value={w.email} />
          <Button type="submit" className="w-full">
            {w.inviteState === "invite_gone"
              ? `Invite ${w.name.split(" ")[0]} again`
              : `Invite ${w.name.split(" ")[0]}`}
          </Button>
        </form>
      )}
    </li>
  );
}

/**
 * "Reset test payments" (Davi, 2026-10-14), live mode only. The line shows the last check's
 * counts (kept in the database), so loading the page asks Stripe nothing new; "Check test
 * payments" asks again. The reset sits behind one confirmation and re-checks every account itself.
 */
function TestPayments({ result }: { result: Awaited<ReturnType<typeof lastTestPaymentsResult>> }) {
  return (
    <div className="flex flex-col gap-2 border-t border-stone pt-3">
      <p className="font-semibold">
        {result ? testPaymentsLine(result) : "Test payments: not checked yet."}
      </p>
      {result ? (
        <p className="text-sm text-muted-foreground">Checked {et.format(new Date(result.at))}.</p>
      ) : null}
      <p>
        Accounts that &ldquo;paid&rdquo; with a Stripe test card before you switched to live mode.
        Checking asks Stripe and changes nothing.
      </p>
      <form action={checkTestPaymentsAction}>
        <PendingButton pending="Checking with Stripe…" variant="outline" className="w-full">
          Check test payments
        </PendingButton>
      </form>
      {result && (result.found > 0 || result.unchecked > 0) ? (
        <details className="rounded-lg border">
          <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
            Reset test payments
          </summary>
          <form action={resetTestPaymentsAction} className="flex flex-col gap-2 px-4 pb-4">
            <p>
              Clears the test-mode Stripe details from those accounts. A setup paid with a test card
              goes back to unpaid: nothing is deleted, sending stays off until they pay for real,
              and their next checkout includes the setup fee. Your own test account keeps sending.
              Safe to tap again.
            </p>
            <p>{PAST_DUE_RESET_NOTE}</p>
            <PendingButton pending="Resetting…" className="w-full">
              Yes, reset test payments
            </PendingButton>
          </form>
        </details>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function WorkspaceCard({
  w,
  now,
  notice,
}: {
  w: AdminRow;
  now: Date;
  /** Check 16 P6: the notice for a move Davi just made on this card. */
  notice?: { text: string; strong: boolean } | null;
}) {
  const own = isAdminEmail(w.ownerEmail);
  const allowed = (Object.keys(ADMIN_MOVES) as AdminMove[]).filter(
    (m) =>
      canMakeMove(m, { status: w.status, evaluationEndsAt: w.evaluationEndsAt }, now) &&
      // The test-account switch only ever shows on Davi's own card.
      (m !== "house_account" || (own && w.setupPaidVia !== "house")),
  );
  const inverted = ["evaluation_expired", "past_due", "paused", "canceled"].includes(w.status);
  const stuck = mailboxesStuck(w.mailboxes);
  return (
    <article
      id={`acct-${w.workspaceId}`}
      aria-label={w.ownerEmail}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      {stuck ? (
        <p className="sa-inverted self-start rounded-md px-2 py-1 text-sm font-black">Stuck</p>
      ) : null}
      {w.waitingOnStripe ? (
        <p className="sa-inverted self-start rounded-md px-2 py-1 font-black">
          {PAID_WAITING_LINE}
        </p>
      ) : null}
      {w.checkoutNeedsReview ? (
        <p className="sa-inverted self-start rounded-md px-2 py-1 font-black">
          {CHECKOUT_REVIEW_LINE}
        </p>
      ) : null}
      {moneyLines(w.moneyEvents).map((l) => (
        <p
          key={l.text}
          className={
            l.strong ? "sa-inverted self-start rounded-md px-2 py-1 font-black" : "font-semibold"
          }
        >
          {l.text}
        </p>
      ))}
      {w.twoLivePlans ? (
        <p className="sa-inverted self-start rounded-md px-2 py-1 font-black">{TWO_PLANS_LINE}</p>
      ) : null}
      {w.status === "paused" && w.hasSubscription ? (
        <p className="font-black">{STILL_BILLED_LINE}</p>
      ) : null}
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
      {notice ? <Notice strong={notice.strong}>{notice.text}</Notice> : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Stat label="Trade" value={isTrade(w.trade) ? tradeLabel[w.trade] : "—"} />
        <Stat label="Plan" value={planName(w.plan, pricing.plans)} />
        <Stat
          label="Setup paid"
          value={
            w.setupPaidVia === "stripe"
              ? "Yes, through Stripe"
              : w.setupPaidVia === "house"
                ? "Your own test account"
                : "Not yet"
          }
        />
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
        <Stat label="Mailboxes" value={mailboxesLine(w.mailboxes, now)} />
        <Stat
          label="Last sync"
          value={w.mailboxes.lastSyncedAt ? relativeTime(w.mailboxes.lastSyncedAt, now) : "Never"}
        />
        <Stat label="Drafts waiting" value={w.drafts.pending} />
        <Stat label="Sent (7 days)" value={w.drafts.sentLast7Days} />
        <Stat label="Drafts this month" value={w.drafts.createdThisMonth} />
        <Stat
          label="Last sorted"
          value={w.health.lastSortedAt ? relativeTime(w.health.lastSortedAt, now) : "Never"}
        />
        <Stat
          label="Last draft"
          value={w.health.lastDraftAt ? relativeTime(w.health.lastDraftAt, now) : "Never"}
        />
        <Stat
          label="Last morning email"
          value={w.health.lastDigestAt ? relativeTime(w.health.lastDigestAt, now) : "Never"}
        />
        <Stat label="AI calls today" value={w.ai.callsToday} />
        <Stat label="AI cost this month" value={`${dollars(w.ai.costCentsThisMonth)} (est.)`} />
        {w.referredByName ? <Stat label="Referred by" value={w.referredByName} /> : null}
        {w.referralCredits.waiting || w.referralCredits.failed ? (
          <Stat
            label="Referral credit"
            value={[
              w.referralCredits.waiting ? `${w.referralCredits.waiting} waiting` : null,
              w.referralCredits.failed
                ? `${w.referralCredits.failed} refused by Stripe${w.referralCredits.lastErrorCode ? ` (${w.referralCredits.lastErrorCode})` : ""}`
                : null,
            ]
              .filter(Boolean)
              .join(", ")}
          />
        ) : null}
      </dl>
      {w.hasSubscription ? (
        <p className="text-sm">{PLAN_SET_BY_STRIPE_LINE}</p>
      ) : (
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
      )}
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
                <p>{m === "pause" ? pauseExplanation(w.hasSubscription) : moves[m].explain}</p>
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
  const referrals = referralsVisible();
  // Check 16 P5: find a shop and page through every account (and invite). q is never logged.
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 200) : "";
  const page = pageNumber(params.page);
  const invitePage = pageNumber(params.ipage);
  const hrefWith = (over: Record<string, string | number | null>) => {
    const sp = new URLSearchParams();
    const merged: Record<string, string | number | null> = {
      q: q || null,
      page: page > 1 ? page : null,
      ipage: invitePage > 1 ? invitePage : null,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== "") sp.set(k, String(v));
    const qs = sp.toString();
    return qs ? `/admin?${qs}` : "/admin";
  };
  // Test payments can only be told apart with the live key. The counts come from the last check
  // (database only): a plain page load asks Stripe nothing new.
  const live = stripeConfigured() && stripeMode() === "live";
  const [
    rows,
    total,
    invited,
    waiting,
    stripeAt,
    system,
    salesTax,
    testPayments,
    termsBoxOff,
    growthClientCount,
    modelsDown,
    launchFacts,
    orphans,
    openDisputes,
    waitingStripe,
    accountCounts,
    inviteTotal,
  ] = await Promise.all([
    adminOverview(now, { q, page }),
    countWorkspaces(q),
    listInvites({ page: invitePage }),
    listWaitlist(),
    stripeConnectedAt(),
    systemHealth(now),
    salesTaxStatus(),
    live ? lastTestPaymentsResult() : null,
    // Database only: set by the last checkout that had to go without the terms box.
    termsBoxOffSince(),
    countGrowthClients(),
    modelsDownToday(now),
    loadLaunchFacts(),
    stripeOrphans(),
    openDisputeCount(),
    stripeWaitingWorkspaces(),
    accountsNeedingYou(now),
    countInvites(),
  ]);
  const growthStates = await growthStateForEmails(waiting.map((w) => w.email));
  // Check 16 P3: Growth requests from the last 7 days (no "called" mark exists yet: Check 16 P4).
  const weekAgo = localStamp(new Date(now.getTime() - 7 * 86_400_000));
  const needs = needsYou({
    growthCalls: waiting.filter((w) => {
      const at = describeWaitlistEntry(w).growth[0]?.at;
      return Boolean(at && at >= weekAgo);
    }).length,
    newSignups: waiting.filter(
      (w) => describeWaitlistEntry(w).app && w.inviteState === "not_invited",
    ).length,
    stuckInboxes: system.staleMailboxes + system.stuckFirstReads,
    ...accountCounts,
  });
  const today = adminToday(now);
  // Waitlist Growth notices show in the waitlist section (the page scrolls there).
  const code = (v: unknown, prefix: string) =>
    typeof v === "string" && v.startsWith(prefix) ? v : undefined;
  const waitlistDone = WAITLIST_GROWTH_DONE[code(params.done, "wl_") ?? ""];
  const waitlistError = WAITLIST_GROWTH_ERRORS[code(params.error, "wl_") ?? ""];
  // Payment messages show inside the Payments section (the page scrolls there), not at the top.
  const isStripe = (k: unknown) => typeof k === "string" && k.startsWith("stripe");
  // Check 16 P6: a move's notice shows inside the card it changed, naming it (not at the top).
  const onCard = cardNotice(params, rows, pricing.plans);
  const doneMsg =
    !onCard && typeof params.done === "string" && !isStripe(params.done)
      ? done[params.done]
      : undefined;
  const errorMsg =
    !onCard && typeof params.error === "string" && !isStripe(params.error)
      ? errors[params.error]
      : undefined;
  const stripeDone =
    params.done === "stripe_test_reset"
      ? testPayments && testPayments.reset !== null
        ? testPaymentsResetNotice({ reset: testPayments.reset, unchecked: testPayments.unchecked })
        : undefined
      : isStripe(params.done)
        ? done[params.done as string]
        : undefined;
  const stripeError = isStripe(params.error) ? errors[params.error as string] : undefined;
  // Only a fixed code travels in the URL (M11 C10); anything else shows nothing.
  const stripeReason = stripeReasonText(params.reason);
  // Check 16 P1: one stuck inbox inverts the box, even when the others are fine.
  const troubleLines = systemTroubleLines(system);
  // Check 48 P3: a model Anthropic said was missing today. Model names and times only.
  const systemInverted = system.jobsLookStopped || troubleLines.length > 0 || modelsDown.length > 0;

  return (
    <>
      <Headline serif="behind the counter," heavy="admin." />
      {/* Check 16 P3: what needs Davi, first thing on a phone. Counts only, never names. */}
      <section
        aria-labelledby="needs-you"
        className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="needs-you" className="text-lg font-black">
          Needs you
        </h2>
        {needs.length === 0 ? (
          <p>{NOTHING_NEEDS_YOU}</p>
        ) : (
          <ul className="flex flex-col">
            {needs.map((l) => (
              <li key={l.key}>
                <a
                  href={l.href}
                  className="flex min-h-tap items-center font-semibold underline underline-offset-4"
                >
                  {l.text}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Link
        href="/admin/costs"
        className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
      >
        AI costs and margins this month
      </Link>
      <p className="text-muted-foreground">
        Health and money only. No email content or customer names are shown here.
      </p>
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section
        aria-labelledby="system"
        className={
          systemInverted
            ? "sa-inverted flex flex-col gap-2 rounded-xl p-4"
            : "flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
        }
      >
        <h2 id="system" className="text-lg font-black">
          {system.jobsLookStopped
            ? "Background jobs look stopped"
            : modelsDown.length
              ? stoppedHeading(modelsDown.map((m) => m.role))
              : troubleLines.length
                ? "An inbox looks stuck"
                : "System"}
        </h2>
        <p>
          {system.workingMailboxes === 0
            ? "No working mailboxes yet."
            : `Last mail check ${system.lastSyncAt ? relativeTime(system.lastSyncAt, now) : "never"} across ${system.workingMailboxes} mailbox${system.workingMailboxes === 1 ? "" : "es"}.`}
          {system.needReconnect
            ? ` ${system.needReconnect} need${system.needReconnect === 1 ? "s" : ""} reconnecting.`
            : ""}
        </p>
        {modelsDown.map((m) => (
          <p key={`${m.role}:${m.model}`} className="font-semibold">
            {modelDownLine(m.role, m.model, et.format(m.since))}
          </p>
        ))}
        {troubleLines.map((line) => (
          <p key={line} className="font-semibold">
            {line}
          </p>
        ))}
        {system.jobsLookStopped ? (
          <p>
            Mail is normally checked every 5 minutes. Open the Inngest dashboard (Vercel → sa →
            Integrations → Inngest) and look for failed runs.
          </p>
        ) : null}
      </section>

      <LaunchReady rows={launchChecks(process.env, launchFacts)} tickAction={tickLaunchAction} />

      <section id="waitlist" aria-labelledby="waitlist-heading" className="flex flex-col gap-3">
        <h2 id="waitlist-heading" className="text-xl font-black">
          {ga.heading(waiting.length)}
        </h2>
        {waitlistDone ? <Notice>{waitlistDone}</Notice> : null}
        {waitlistError ? <Notice strong>{waitlistError}</Notice> : null}
        {waiting.length === 0 ? (
          <p>{ga.empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {waiting.map((w) => (
              <WaitlistEntry
                key={w.email}
                w={w}
                now={now}
                referrals={referrals}
                growth={growthStates.get(w.email.toLowerCase())}
                today={today}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="accounts" className="flex flex-col gap-3">
        <h2 id="accounts" className="text-xl font-black">
          Accounts ({total})
        </h2>
        <form method="get" action="/admin" role="search" className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Find a shop (name or email)</span>
            <input
              name="q"
              type="search"
              defaultValue={q}
              maxLength={200}
              autoComplete="off"
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            />
          </label>
          <div className="flex items-center gap-4">
            <Button type="submit" variant="outline">
              Find
            </Button>
            {q ? (
              <Link
                href="/admin#accounts"
                className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              >
                Clear
              </Link>
            ) : null}
          </div>
        </form>
        {rows.length === 0 ? (
          <p>{q ? "No shop matches that." : "No one has signed in yet."}</p>
        ) : null}
        {rows.map((w) =>
          isAdminEmail(w.ownerEmail) ? (
            // Check 16 P3: Davi's own test account folds to one line; its moves still work.
            <details
              key={w.workspaceId}
              className="rounded-xl border"
              open={onCard?.workspaceId === w.workspaceId}
            >
              <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
                Your test account: {w.businessName || w.ownerEmail} · {statusLabel[w.status]}
              </summary>
              <div className="p-2">
                <WorkspaceCard
                  w={w}
                  now={now}
                  notice={onCard?.workspaceId === w.workspaceId ? onCard : null}
                />
              </div>
            </details>
          ) : (
            <WorkspaceCard
              key={w.workspaceId}
              w={w}
              now={now}
              notice={onCard?.workspaceId === w.workspaceId ? onCard : null}
            />
          ),
        )}
        {total > ADMIN_PAGE_SIZE ? (
          <nav aria-label="More accounts" className="flex flex-col gap-1">
            <p className="text-muted-foreground">
              Showing {Math.min((page - 1) * ADMIN_PAGE_SIZE + 1, total)} to{" "}
              {Math.min(page * ADMIN_PAGE_SIZE, total)} of {total}.
            </p>
            {page * ADMIN_PAGE_SIZE < total ? (
              <Link
                href={`${hrefWith({ page: page + 1 })}#accounts`}
                className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              >
                Show older accounts
              </Link>
            ) : null}
            {page > 1 ? (
              <Link
                href={`${hrefWith({ page: page - 1 > 1 ? page - 1 : null })}#accounts`}
                className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              >
                Show newer accounts
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>

      <section id="stripe" aria-labelledby="stripe-heading" className="flex flex-col gap-3">
        <h2 id="stripe-heading" className="text-xl font-black">
          Payments
        </h2>
        {stripeDone ? <Notice>{stripeDone}</Notice> : null}
        {stripeError ? (
          <Notice strong>
            {stripeError}
            {stripeReason ? ` ${stripeReason}` : null}
          </Notice>
        ) : null}
        {waitingStripe.size > 0 ? (
          <p className="sa-inverted rounded-xl p-4 font-black">
            {stripeWaitingLine(waitingStripe.size)}
          </p>
        ) : null}
        {openDisputesLine(openDisputes) ? (
          <p className="sa-inverted rounded-xl p-4 font-black">{openDisputesLine(openDisputes)}</p>
        ) : null}
        {orphans && orphans.count > 0 ? (
          <form
            action={clearStripeOrphansAction}
            className="sa-inverted flex flex-col gap-2 rounded-xl p-4"
          >
            <p className="font-black">{ORPHAN_PLAN_LINE}</p>
            <p>
              {orphans.count === 1 ? "Once" : `${orphans.count} times`}, last{" "}
              {et.format(orphans.at)}. Look in Stripe → Customers for a plan whose account was
              deleted or never matched.
            </p>
            <Button type="submit" variant="outline" className="w-full">
              I checked Stripe
            </Button>
          </form>
        ) : null}
        {stripeConfigured() ? (
          <>
            <form action={connectStripeAction} className="flex flex-col gap-2">
              <p className="font-semibold">
                {stripeAt ? `Connected · last set up ${et.format(stripeAt)}` : "Not connected yet."}
              </p>
              {salesTax ? <p>{SALES_TAX_LINES[salesTax]}</p> : null}
              {salesTax === "on" ? <p>{SALES_TAX_ON_NOTE}</p> : null}
              {termsBoxOff ? (
                <p className="font-semibold">
                  {TERMS_BOX_OFF_LINE} (Last checkout without it: {et.format(termsBoxOff)}.)
                </p>
              ) : null}
              <p>
                Sets up the four prices from the price list, the customer billing page, and the
                payment notifications that switch accounts on and off. Takes about 10 seconds. Safe
                to tap again. It also makes the prices add tax on top, so tap it once before setting
                up Stripe Tax.
              </p>
              <PendingButton pending="Connecting to Stripe…" className="w-full">
                {stripeAt ? "Connect Stripe again" : "Connect Stripe"}
              </PendingButton>
            </form>
            {live ? <TestPayments result={testPayments} /> : <p>{TEST_PAYMENTS_TEST_MODE}</p>}
          </>
        ) : (
          <p>Add STRIPE_SECRET_KEY to the sa project in Vercel first.</p>
        )}
      </section>

      <section aria-labelledby="growth-heading" className="flex flex-col gap-2">
        <h2 id="growth-heading" className="text-xl font-black">
          Growth clients ({growthClientCount})
        </h2>
        <Link
          href="/admin/growth"
          className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
        >
          Start Growth, post updates and enter monthly numbers
        </Link>
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
                  {tradeLabel[t]}
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
            Invite and email them
          </Button>
          <p className="text-sm text-muted-foreground">
            This lets them sign in and emails them the sign-in link, with what to have ready. Until
            Google approves the app, also add them as a test user in Google Cloud.
          </p>
        </form>
        {invited.length ? (
          <ul className="flex flex-col divide-y rounded-lg border">
            {invited.map((i) => (
              <li key={i.email} className="flex flex-col gap-2 px-4 py-2">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate">{i.email}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {i.acceptedAt ? "Signed in" : "Not yet"}
                  </span>
                </span>
                {!i.acceptedAt ? (
                  // Check 16 P7: a typo or a mistaken invite can be taken back before it's used.
                  <details className="rounded-lg border">
                    <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
                      Take back this invite
                    </summary>
                    <form action={removeInviteAction} className="flex flex-col gap-2 px-4 pb-4">
                      <input type="hidden" name="email" value={i.email} />
                      <p>
                        They won&apos;t be able to sign in. The email we sent them stops working.
                      </p>
                      <Button type="submit" className="w-full">
                        Yes, take back the invite
                      </Button>
                    </form>
                  </details>
                ) : null}
                {/* Round 2 (FW A4): until Google approves the app, only test users get in. */}
                {i.testUserAddedAt ? (
                  <span className="text-sm text-muted-foreground">Google test user: added</span>
                ) : (
                  <form action={testUserAddedAction} className="flex flex-col gap-1">
                    <input type="hidden" name="email" value={i.email} />
                    <span className="text-sm">
                      Add them as a Google test user in{" "}
                      <a
                        href={GOOGLE_AUDIENCE_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold underline underline-offset-4"
                      >
                        Google Cloud → Audience
                      </a>
                      , or Google won&apos;t let them in.
                    </span>
                    <Button type="submit" variant="outline" className="w-full">
                      I added them
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {inviteTotal > ADMIN_PAGE_SIZE ? (
          <nav aria-label="More invites" className="flex flex-col gap-1">
            <p className="text-muted-foreground">
              Showing {Math.min((invitePage - 1) * ADMIN_PAGE_SIZE + 1, inviteTotal)} to{" "}
              {Math.min(invitePage * ADMIN_PAGE_SIZE, inviteTotal)} of {inviteTotal} invites.
            </p>
            {invitePage * ADMIN_PAGE_SIZE < inviteTotal ? (
              <Link
                href={`${hrefWith({ ipage: invitePage + 1 })}#invite`}
                className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              >
                Show older invites
              </Link>
            ) : null}
            {invitePage > 1 ? (
              <Link
                href={`${hrefWith({ ipage: invitePage - 1 > 1 ? invitePage - 1 : null })}#invite`}
                className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              >
                Show newer invites
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </>
  );
}
