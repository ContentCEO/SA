import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { formatDollars, pricing } from "@/config/pricing";
import { COST_ALERT_SHARE } from "@/server/admin-cost-rules";
import { costRows } from "@/server/admin-costs";
import { statusLabel } from "@/server/admin-rules";
import { STRIPE_FEES } from "@/config/fees";
import { requireAdmin } from "@/server/session";
import { cn } from "@/lib/utils";

const money = (cents: number) => (cents < 0 ? `−${formatDollars(-cents)}` : formatDollars(cents));

export const metadata: Metadata = { title: "AI costs", robots: { index: false } };

// No loading.tsx here: requireAdmin must 404 for everyone else.

/**
 * Plan #45: what each account costs in AI this month against what its plan
 * pays, worst margin first. Money and counts only — no email content, no
 * customer names.
 */
export default async function AdminCostsPage() {
  await requireAdmin();
  const rows = await costRows();
  const total = rows.reduce(
    (t, r) => ({
      cost: t.cost + r.costCents,
      revenue: t.revenue + r.revenueCents,
      fees: t.fees + r.feesCents,
    }),
    { cost: 0, revenue: 0, fees: 0 },
  );

  return (
    <>
      <Headline serif="this month," heavy="AI costs." />
      <p>
        AI cost is an estimate from token counts. Revenue is the monthly plan for paying accounts
        (setup fees and your own test account not counted). &ldquo;After Stripe&rdquo; takes off
        Stripe&apos;s card and billing fees ({(STRIPE_FEES.cardPercent * 100).toFixed(1)}% +{" "}
        {STRIPE_FEES.cardFixedCents}¢, plus {(STRIPE_FEES.billingPercent * 100).toFixed(1)}%; sales
        tax fees not counted). You get an email when an account passes{" "}
        {Math.round(COST_ALERT_SHARE * 100)}% of its plan price.
      </p>
      <dl className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-4">
        {[
          ["Plans", formatDollars(total.revenue)],
          ["After Stripe", formatDollars(total.revenue - total.fees)],
          ["AI cost", formatDollars(total.cost)],
          ["Keeps", money(total.revenue - total.fees - total.cost)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-sm text-muted-foreground">{k}</dt>
            <dd className="text-xl font-black">{v}</dd>
          </div>
        ))}
      </dl>
      {rows.length === 0 ? (
        <p className="text-lg">No accounts yet.</p>
      ) : (
        <ol aria-label="Accounts by margin" className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.workspaceId}
              className={cn(
                "flex flex-col gap-1 rounded-xl border p-3",
                r.alert ? "sa-inverted" : "bg-card",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-black">{r.label}</span>
                <span className="shrink-0 text-sm font-semibold">
                  {r.plan ? pricing.plans[r.plan].name : "No plan"} · {statusLabel[r.status]}
                </span>
              </div>
              {r.house ? (
                <p>Your test account · AI {formatDollars(r.costCents)}</p>
              ) : r.revenueCents ? (
                <p>
                  plan {formatDollars(r.revenueCents)} · after Stripe{" "}
                  {formatDollars(r.revenueCents - r.feesCents)} · AI {formatDollars(r.costCents)} ·
                  keeps <span className="font-black">{money(r.marginAfterFeesCents)}</span>
                  {r.costShare !== null ? ` · AI is ${Math.round(r.costShare * 100)}% of plan` : ""}
                </p>
              ) : (
                <p>Not paying yet · AI {formatDollars(r.costCents)}</p>
              )}
              <p className="text-sm">
                {r.calls} AI calls this month · busiest day {r.busiestDayCalls} of {r.cap}
              </p>
              {r.alert ? <p className="font-black">Over the alert line</p> : null}
            </li>
          ))}
        </ol>
      )}
      <Link href="/admin" className="inline-flex min-h-tap items-center font-semibold underline">
        Back to Admin
      </Link>
    </>
  );
}
