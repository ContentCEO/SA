import type { Metadata } from "next";
import { ConfirmChange } from "@/components/app/confirm-change";
import { CopyLink } from "@/components/app/copy-link";
import { Notice } from "@/components/app/notice";
import { RefreshUntil } from "@/components/app/refresh-until";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { formatDollars, planRank, pricing, type PlanId } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import { stripeConfigured } from "@/server/billing";
import { billingStatusLine, checkoutTerms, PLAN_IDS, SALES_TAX_NOTE } from "@/server/billing-rules";
import {
  billedPlanFreeLine,
  freeMonthBanner,
  freeMonthRunning,
  freeMonthSummary,
  goBackCopy,
  goBackOffer,
  keepCopy,
  keepOffer,
  referralsVisible,
  rewardStatusLine,
  shareCardCopy,
  shortDate,
  stripePageShowsLine,
} from "@/server/referral-rules";
import { EARN_THRESHOLD } from "@/server/autopilot";
import { effectiveStatus } from "@/server/lifecycle";
import { freeMonthView, referralLinkFor, viewChanges } from "@/server/referrals";
import { requireOwner } from "@/server/session";
import { goBackAction, keepFreePlanAction, openPortalAction, startCheckoutAction } from "./actions";

export const metadata: Metadata = { title: "Plan & billing" };

const errors: Record<string, string> = {
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
  canceled: "Checkout was closed before paying. Nothing was charged.",
  has_plan: "You already have a plan — use Manage billing to change it.",
  unknown: "That didn't work. Refresh and try again.",
  // Plan #47 Keep / Go back. Nothing was changed in any of these.
  not_offered: "That isn't on offer any more. Here's where things stand now.",
  price_changed: "The price changed. Check it again.",
  plan_busy: "Still working on your last tap. Try again in a minute.",
  stripe_off: `Online payment isn't switched on yet. Call ${siteConfig.operator} at ${siteConfig.phone} to change plans.`,
  stripe_down: "Stripe didn't answer. Try again in a minute.",
  changed: "Something changed. Try again.",
  schedule: `Your plan has a change booked in Stripe. Call ${siteConfig.operator.split(" ")[0]} at ${siteConfig.phone}.`,
  ended: "Your free month just ended. Change plans with Manage billing.",
};

export default async function BillingPage(props: PageProps<"/billing">) {
  const { workspace } = await requireOwner();
  const now = new Date();
  const params = await props.searchParams;
  const statusLine = billingStatusLine(workspace);
  const terms = checkoutTerms(workspace);
  const paidJustNow = params.done === "paid";
  const waitingForStripe = paidJustNow && terms.allowed;
  const current = workspace.plan ? pricing.plans[workspace.plan as PlanId] : null;
  // Plan #47: the share card only while referrals are switched on — hidden entirely otherwise.
  // A free month already booked or running carries on either way (Stripe holds the coupon).
  const share = referralsVisible()
    ? shareCardCopy({ plan: workspace.plan, status: effectiveStatus(workspace) }, EARN_THRESHOLD)
    : null;
  const shareLink = share ? await referralLinkFor(workspace.id) : null;
  const view = await freeMonthView(workspace.id);
  const tz = view.timeZone;
  const running =
    view.running &&
    freeMonthRunning(workspace, now) &&
    workspace.freePlan &&
    workspace.freePlanUntil
      ? { row: view.running, free: workspace.freePlan, until: workspace.freePlanUntil }
      : null;
  const keep = running ? keepOffer(workspace, running.row, now) : null;
  const back = running ? goBackOffer(workspace, running.row, now) : null;
  const goingBackTo =
    running && workspace.plan && planRank(running.free) > planRank(workspace.plan)
      ? workspace.plan
      : null;
  const statusForShare =
    share &&
    view.waiting &&
    (view.waiting.status === "pending" || view.waiting.status === "scheduled")
      ? rewardStatusLine({
          reward: { status: view.waiting.status, startsAt: view.waiting.startsAt },
          workspace,
          anotherFreeMonth: view.anotherFreeMonth,
          timeZone: tz,
          now,
        })
      : null;

  const doneMsg =
    params.done === "kept" && running
      ? keepCopy({
          free: running.free,
          priceCents: running.row.keptPriceCents ?? pricing.plans[running.free].amountCents,
          paidPriceCents: running.row.paidPriceCents,
          firstChargeAt: running.until,
          timeZone: tz,
        }).notice
      : params.done === "kept"
        ? "Kept."
        : params.done === "went_back" && running && running.row.paidPlan
          ? `Done. Back to ${pricing.plans[running.row.paidPlan].name} after ${shortDate(running.until, tz)}.`
          : params.done === "went_back"
            ? "Done."
            : undefined;
  const errorMsg =
    params.error === "set_to_end"
      ? workspace.stripeCancelAt
        ? `Your plan is set to end on ${shortDate(workspace.stripeCancelAt, tz)}. Turn renewal back on in Manage billing first.`
        : "Your plan is set to end. Turn renewal back on in Manage billing first."
      : typeof params.error === "string"
        ? errors[params.error]
        : undefined;

  return (
    <>
      <Headline serif="your plan," heavy="plain and simple." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      {waitingForStripe ? (
        <section role="status" className="sa-inverted flex flex-col gap-2 rounded-xl p-4">
          <RefreshUntil />
          <p className="text-lg font-black">Payment received — finishing up.</p>
          <p className="text-ash">This takes a few seconds. The page updates by itself.</p>
        </section>
      ) : paidJustNow ? (
        <Notice>Payment received. Thank you — you&apos;re all set.</Notice>
      ) : null}

      {current ? (
        <section
          aria-labelledby="current"
          className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
        >
          <h2 id="current" className="text-xl font-black">
            {current.name} · {formatDollars(current.amountCents)} / month
          </h2>
          {statusLine ? <p>{statusLine}</p> : null}
          {/* Plan #47: what's billed stays the heading; the free plan is a line under it. */}
          {running ? <p>{billedPlanFreeLine(running.free, running.until, tz)}</p> : null}
          {/* Stripe's page needs a Stripe customer: none for a plan set by hand or reset. */}
          {workspace.stripeCustomerId ? (
            <>
              <form action={openPortalAction}>
                <Button type="submit" variant="outline" className="w-full">
                  Manage billing
                </Button>
              </form>
              <p className="text-sm text-muted-foreground">
                Change plan, update your card, see invoices or cancel — on Stripe&apos;s secure
                page.
              </p>
              {running && workspace.plan && workspace.plan !== running.free ? (
                <p className="text-sm text-muted-foreground">
                  {stripePageShowsLine(workspace.plan)}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {running ? (
        <section
          id="free-month"
          aria-labelledby="free-month-heading"
          className="flex scroll-mt-4 flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
        >
          <h2 id="free-month-heading" className="text-xl font-black">
            Your free month
          </h2>
          {goingBackTo ? (
            freeMonthSummary({
              free: running.free,
              until: running.until,
              backTo: goingBackTo,
              backToPriceCents:
                running.row.paidPriceCents ?? pricing.plans[goingBackTo].amountCents,
              changes: viewChanges(view, goingBackTo),
              timeZone: tz,
            }).map((line) => <p key={line}>{line}</p>)
          ) : (
            <p>
              {freeMonthBanner({
                workspace,
                reward: running.row,
                changes: null,
                timeZone: tz,
                now,
              })?.line ?? billedPlanFreeLine(running.free, running.until, tz)}
            </p>
          )}
          {keep
            ? (() => {
                const c = keepCopy({
                  free: keep.plan,
                  priceCents: keep.priceCents,
                  paidPriceCents: running.row.paidPriceCents,
                  firstChargeAt: keep.firstChargeAt,
                  timeZone: tz,
                });
                return (
                  <ConfirmChange
                    button={c.button}
                    title={c.title}
                    body={[c.body]}
                    yes={c.yes}
                    no={c.no}
                    fields={{
                      rewardId: running.row.id,
                      plan: keep.plan,
                      priceCents: String(keep.priceCents),
                    }}
                    action={keepFreePlanAction}
                  />
                );
              })()
            : null}
          {back
            ? (() => {
                const c = goBackCopy({
                  backTo: back.plan,
                  paidPriceCents: back.priceCents,
                  at: back.at,
                  changes: viewChanges(view, back.plan),
                  timeZone: tz,
                });
                return (
                  <>
                    <p>{c.prompt}</p>
                    <ConfirmChange
                      button={c.button}
                      title={c.title}
                      body={c.body}
                      yes={c.yes}
                      no={c.no}
                      fields={{ rewardId: running.row.id }}
                      action={goBackAction}
                    />
                  </>
                );
              })()
            : null}
        </section>
      ) : null}

      {terms.allowed ? (
        !stripeConfigured() ? (
          <Notice strong>
            Online payment isn&apos;t switched on yet. Call {siteConfig.operator} at{" "}
            {siteConfig.phone} to get set up.
          </Notice>
        ) : (
          <section aria-labelledby="choose" className="flex flex-col gap-3">
            <h2 id="choose" className="text-xl font-black">
              Choose a plan
            </h2>
            {terms.includeSetupFee ? (
              <p>
                Every plan starts with a one-time{" "}
                <span className="font-semibold">
                  {pricing.setupFee.name.toLowerCase()} of{" "}
                  {formatDollars(pricing.setupFee.amountCents)}
                </span>
                : a call with us to load your prices, hours and never-promise list, and tune your
                drafts. It&apos;s added to your first payment.
              </p>
            ) : null}
            <ul className="flex flex-col gap-3">
              {PLAN_IDS.map((id) => {
                const p = pricing.plans[id];
                const featured = id === "crew";
                return (
                  <li
                    key={id}
                    aria-label={`${p.name} plan`}
                    className={cn(
                      "flex flex-col gap-2 rounded-xl p-4",
                      featured ? "sa-inverted" : "border bg-card",
                    )}
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="text-xl font-black">{p.name}</span>
                      <span>
                        <span className="text-2xl font-black">{formatDollars(p.amountCents)}</span>
                        <span className={featured ? "text-ash" : "text-muted-foreground"}>
                          {" "}
                          / month
                        </span>
                      </span>
                    </div>
                    <p className={featured ? "text-ash" : "text-muted-foreground"}>
                      {p.mailboxLimit} Gmail inbox{p.mailboxLimit === 1 ? "" : "es"}
                      {p.autopilot ? " · Autopilot" : ""}
                      {id === "company" ? " · Priority support" : ""}
                    </p>
                    <form action={startCheckoutAction}>
                      <input type="hidden" name="plan" value={id} />
                      <Button type="submit" className="w-full">
                        Choose {p.name}
                      </Button>
                    </form>
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-muted-foreground">{SALES_TAX_NOTE}</p>
            <p className="text-sm text-muted-foreground">
              Paid securely through Stripe. Month to month — cancel any time from Manage billing.
            </p>
          </section>
        )
      ) : null}

      {share && shareLink ? (
        <section aria-labelledby="refer" className="flex flex-col gap-3 rounded-xl border p-4">
          <h2 id="refer" className="text-xl font-black">
            {share.title}
          </h2>
          <p>{share.intro}</p>
          <p>
            {share.plan}
            {share.setup ? ` ${share.setup}` : null}
          </p>
          <p>{share.after}</p>
          <CopyLink url={shareLink} label="Your link" />
          {statusForShare ? <p className="font-semibold">{statusForShare}</p> : null}
        </section>
      ) : null}
    </>
  );
}
