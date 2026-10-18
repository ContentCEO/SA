import type { Metadata } from "next";
import { CopyLink } from "@/components/app/copy-link";
import { Notice } from "@/components/app/notice";
import { RefreshUntil } from "@/components/app/refresh-until";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { formatDollars, pricing, type PlanId } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { FEATURED_PLAN, planFeatureLines } from "@/server/plan-features";
import { cn } from "@/lib/utils";
import { stripeConfigured } from "@/server/billing";
import {
  billingStatusLine,
  checkoutTerms,
  firstChargeLine,
  PLAN_IDS,
  setupCallSentence,
} from "@/server/billing-rules";
import { effectiveStatus, setupReallyPaid } from "@/server/lifecycle";
import { phoneHref } from "@/lib/phone-href";
import { referralCredit } from "@/server/referral-rules";
import { referralLinkFor } from "@/server/referrals";
import { requireOwner } from "@/server/session";
import { TRIAL_NO_SEND_LINE, TRIAL_SIDE_DOOR_LINE } from "@/server/trial-email-rules";
import { openPortalAction, startCheckoutAction } from "./actions";

export const metadata: Metadata = { title: "Plan & billing" };

const errors: Record<string, string> = {
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
  canceled: "Checkout was closed before paying. Nothing was charged.",
  has_plan: "You already have a plan — use Manage billing to change it.",
  unknown: "That didn't work. Refresh and try again.",
};

export default async function BillingPage(props: PageProps<"/billing">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const statusLine = billingStatusLine(workspace);
  const terms = checkoutTerms(workspace);
  const paidJustNow = params.done === "paid";
  const waitingForStripe = paidJustNow && terms.allowed;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const current = workspace.plan ? pricing.plans[workspace.plan as PlanId] : null;
  // Plan #47: only while referrals are switched on (flag and an amount) — hidden entirely otherwise.
  const referral = referralCredit();
  const shareLink = referral ? await referralLinkFor(workspace.id) : null;
  // Round 2 (FW): paid, setup call still to come — say what happens next.
  const awaitingSetupCall =
    effectiveStatus(workspace) === "setup_paid" && setupReallyPaid(workspace);
  const davi = siteConfig.operator.split(" ")[0];
  const onTrial = effectiveStatus(workspace) === "evaluating";

  return (
    <>
      <Headline serif="your plan," heavy="plain and simple." />
      {onTrial ? (
        // The trial's side door (Davi, 2026-10-16), and what a plan changes.
        <p className="text-lg">
          {TRIAL_NO_SEND_LINE} {TRIAL_SIDE_DOOR_LINE} A plan turns on Send reply in Squared Away,
          and every reply still waits for your okay.
        </p>
      ) : null}
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

      {awaitingSetupCall ? (
        <section
          aria-labelledby="next-steps"
          className="sa-inverted flex flex-col gap-3 rounded-xl p-4"
        >
          <h2 id="next-steps" className="text-xl font-black">
            What happens next
          </h2>
          <ol className="flex list-decimal flex-col gap-2 pl-5">
            <li>
              {davi} calls you to find a time for your setup call. Rather pick it yourself? Call or
              text{" "}
              <a
                href={phoneHref("tel", siteConfig.phone)}
                className="font-semibold underline underline-offset-4"
              >
                {siteConfig.phone}
              </a>
              .
            </li>
            <li>
              Have your price list handy. On the call, {davi} {setupCallSentence("after")}.
            </li>
            <li>Sending is on now. Every reply still waits for you to tap Send reply.</li>
          </ol>
        </section>
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
            </>
          ) : null}
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
                : a call with us to {setupCallSentence("before")}. It&apos;s added to your first
                payment.
              </p>
            ) : null}
            <ul className="flex flex-col gap-3">
              {PLAN_IDS.map((id) => {
                const p = pricing.plans[id];
                const featured = id === FEATURED_PLAN;
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
                      {planFeatureLines(id).join(" · ")}
                    </p>
                    <p className="text-sm">{firstChargeLine(id, terms.includeSetupFee)}</p>
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
            {/* Each card's first-payment line already says "plus sales tax" (Check 35 P2). */}
            <p className="text-sm text-muted-foreground">
              Paid securely through Stripe. Month to month — cancel any time from Manage billing.
            </p>
          </section>
        )
      ) : null}

      {referral && shareLink ? (
        <section aria-labelledby="refer" className="flex flex-col gap-3 rounded-xl border p-4">
          <h2 id="refer" className="text-xl font-black">
            Share Squared Away
          </h2>
          <p>
            Know another contractor who&apos;d like this? Send them your link. Once they&apos;ve
            paid and finished their setup call,{" "}
            {referral.sides.length === 2
              ? `you each get ${formatDollars(referral.cents)} off your bill`
              : referral.sides[0] === "referrer"
                ? `you get ${formatDollars(referral.cents)} off your bill`
                : `they get ${formatDollars(referral.cents)} off their bill`}
            . Once per new business. They need to join the waitlist from your link, or it won&apos;t
            count.
          </p>
          <CopyLink url={shareLink} label="Your link" />
        </section>
      ) : null}
    </>
  );
}
