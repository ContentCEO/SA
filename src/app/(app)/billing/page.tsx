import type { Metadata } from "next";
import { CopyLink } from "@/components/app/copy-link";
import { Notice } from "@/components/app/notice";
import { RefreshUntil } from "@/components/app/refresh-until";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { formatDollars, pricing, type PlanId } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import { stripeConfigured } from "@/server/billing";
import { billingStatusLine, checkoutTerms, PLAN_IDS, SALES_TAX_NOTE } from "@/server/billing-rules";
import { referralsVisible, shareCardCopy } from "@/server/referral-rules";
import { EARN_THRESHOLD } from "@/server/autopilot";
import { effectiveStatus } from "@/server/lifecycle";
import { referralLinkFor } from "@/server/referrals";
import { requireOwner } from "@/server/session";
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
  // Plan #47: only while referrals are switched on — hidden entirely otherwise.
  const share = referralsVisible()
    ? shareCardCopy({ plan: workspace.plan, status: effectiveStatus(workspace) }, EARN_THRESHOLD)
    : null;
  const shareLink = share ? await referralLinkFor(workspace.id) : null;

  return (
    <>
      <Headline serif="your plan," heavy="plain and simple." />
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
        </section>
      ) : null}
    </>
  );
}
