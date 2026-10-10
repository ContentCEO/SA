import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Checklist } from "@/server/onboarding";
import { cn } from "@/lib/utils";

/** Getting started (plan #39). Done steps are struck through and bold-free; the next one is heavy. */
export function OnboardingChecklist({
  list,
  dismissAction,
}: {
  list: Checklist;
  dismissAction: () => Promise<void>;
}) {
  if (!list.show) return null;
  const next = list.steps.find((s) => !s.done)?.key;
  return (
    <section
      aria-labelledby="getting-started"
      className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
    >
      <h2 id="getting-started" className="text-lg font-black">
        {list.allDone ? "You're all set up." : "Getting started"}
      </h2>
      <ol className="flex flex-col gap-1">
        {list.steps.map((s, i) => (
          <li key={s.key}>
            <Link
              href={s.href}
              aria-label={`${s.label}${s.done ? " — done" : ""}`}
              className={cn(
                "flex min-h-tap items-center gap-3 rounded-lg px-2",
                s.key === next && "sa-inverted",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-current text-sm font-black",
                )}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className={cn("flex-1", s.done ? "line-through opacity-70" : "font-semibold")}>
                {s.label}
              </span>
              {s.detail && !s.done ? <span className="text-sm">{s.detail}</span> : null}
            </Link>
          </li>
        ))}
      </ol>
      {list.allDone ? (
        <form action={dismissAction}>
          <Button type="submit" variant="outline" className="w-full">
            Hide this list
          </Button>
        </form>
      ) : null}
    </section>
  );
}
