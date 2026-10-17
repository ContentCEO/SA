import { formatDollars, pricing } from "@/config/pricing";
import { cn } from "@/lib/utils";
import { firstChargeLine, PLAN_IDS } from "@/server/billing-rules";

/** The homepage's plan cards, keyed on plan ids (Check 35 P2 / P4). */
export function PlanCards() {
  return (
    <ul className="grid gap-4 md:grid-cols-3">
      {PLAN_IDS.map((id) => {
        const p = pricing.plans[id];
        const featured = id === "crew";
        return (
          <li
            key={id}
            className={cn(
              "flex flex-col gap-3 rounded-2xl p-6",
              featured ? "sa-inverted" : "border bg-card",
            )}
          >
            <span className="text-xl font-black">{p.name}</span>
            <span>
              <span className="sa-headline-heavy text-5xl">{formatDollars(p.amountCents)}</span>
              <span className={featured ? "text-ash" : "text-slate"}> / month</span>
            </span>
            {/* Check 35 P2: the first payment in the same words as /billing. A visitor
                has never paid setup, so it's always included. */}
            <p className={cn("text-base", featured ? "text-ash" : "text-slate")}>
              {firstChargeLine(id, true)}
            </p>
            <ul className="flex flex-col gap-1.5 text-lg">
              <li>
                {p.mailboxLimit} Gmail inbox{p.mailboxLimit === 1 ? "" : "es"}
              </li>
              <li>Sorting, drafts, follow-ups, morning summary</li>
              {p.autopilot ? <li>Autopilot for the emails you choose</li> : null}
              {id === "company" ? <li>Priority support</li> : null}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
