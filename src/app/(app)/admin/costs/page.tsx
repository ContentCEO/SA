import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { formatDollars, pricing } from "@/config/pricing";
import { COST_ALERT_SHARE } from "@/server/admin-cost-rules";
import { costRows } from "@/server/admin-costs";
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
    (t, r) => ({ cost: t.cost + r.costCents, revenue: t.revenue + r.revenueCents }),
    { cost: 0, revenue: 0 },
  );

  return (
    <>
      <Headline serif="this month," heavy="AI costs." />
      <p>
        AI cost is an estimate from token counts. Revenue is the monthly plan for paying accounts
        (setup fees not counted). You get an email when an account passes{" "}
        {Math.round(COST_ALERT_SHARE * 100)}% of its plan price.
      </p>
      <dl className="grid grid-cols-3 gap-2 rounded-xl border bg-card p-4">
        {[
          ["AI cost", formatDollars(total.cost)],
          ["Plans", formatDollars(total.revenue)],
          ["Margin", money(total.revenue - total.cost)],
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
                  {r.plan ? pricing.plans[r.plan].name : "No plan"} · {r.status.replace("_", " ")}
                </span>
              </div>
              <p>
                AI {formatDollars(r.costCents)} · plan {formatDollars(r.revenueCents)} · margin{" "}
                <span className="font-black">{money(r.marginCents)}</span>
                {r.costShare !== null ? ` · ${Math.round(r.costShare * 100)}% of plan` : ""}
              </p>
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
