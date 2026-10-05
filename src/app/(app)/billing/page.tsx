import type { Metadata } from "next";
import { Notice } from "@/components/app/notice";
import { RefreshUntil } from "@/components/app/refresh-until";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { formatDollars, pricing, type PlanId } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import { stripeConfigured } from "@/server/billing";
import { checkoutTerms, PLAN_IDS } from "@/server/billing-rules";
import { effectiveStatus } from "@/server/lifecycle";
import { requireOwner } from "@/server/session";
import { openPortalAction, startCheckoutAction } from "./actions";

export const metadata: Metadata = { title: "Plan & billing" };

const errors: Record<string, string> = {
  canceled: "Checkout was closed before paying. Nothing was charged.",
  has_plan: "You already have a plan — use Manage billing to change it.",
  unknown: "That didn't work. Refresh and try again.",
};

const statusLine: Partial<Record<string, string>> = {
  setup_paid: "Setup's paid and sending is on. We'll call to finish setting you up.",
  active: "All set. Your plan renews monthly.",
  past_due: "Your last payment didn't go through. Update your card to switch things back on.",
  canceled: "Your plan has ended. Pick a plan below to start again — nothing was deleted.",
};

export default async function BillingPage(props: PageProps<"/billing">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const status = effectiveStatus(workspace);
  const terms = checkoutTerms(workspace);
  const paidJustNow = params.done === "paid";
  const waitingForStripe = paidJustNow && terms.allowed;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const current = workspace.plan ? pricing.plans[workspace.plan as PlanId] : null;

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
          {statusLine[status] ? <p>{statusLine[status]}</p> : null}
          {workspace.stripeCustomerId ? (
            <form action={openPortalAction}>
              <Button type="submit" variant="outline" className="w-full">
                Manage billing
              </Button>
            </form>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Change plan, update your card, see invoices or cancel — on Stripe&apos;s secure page.
          </p>
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
            <p className="text-sm text-muted-foreground">
              Paid securely through Stripe. Month to month — cancel any time from Manage billing.
            </p>
          </section>
        )
      ) : null}
    </>
  );
}
