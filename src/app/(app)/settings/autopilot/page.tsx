import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { categoryLabels } from "@/config/categories";
import { autopilotState, EARN_THRESHOLD, GRACE_MINUTES } from "@/server/autopilot";
import { AUTOPILOT_NEVER_LINES, AUTOPILOT_WHEN_LINES } from "@/server/autopilot-reasons";
import { requireOwner } from "@/server/session";
import { setAutopilotAction } from "../profile-actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Autopilot" };

export default async function AutopilotSettingsPage(props: PageProps<"/settings/autopilot">) {
  const { workspace } = await requireOwner();
  const autopilot = await autopilotState(workspace);
  return (
    <SettingsScreen path="/settings/autopilot" heavy="autopilot." params={await props.searchParams}>
      <section aria-labelledby="autopilot-heading" className="flex flex-col gap-3">
        <h2 id="autopilot-heading" className="sr-only">
          Autopilot
        </h2>
        <p className="text-muted-foreground">
          Lets Squared Away send replies on its own for the kinds of email you choose. Off until you
          turn it on.
        </p>
        {/* Check 20 P6: one rule per line, from the same codes the guardrails use. */}
        <div className="flex flex-col gap-1">
          <p className="font-semibold">It sends on its own only when all of these are true:</p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {AUTOPILOT_WHEN_LINES.map((l) => (
              <li key={l.text}>{l.text}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-1">
          <p className="font-semibold">It never sends:</p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {AUTOPILOT_NEVER_LINES.map((l) => (
              <li key={l.text}>{l.text}</li>
            ))}
          </ul>
        </div>
        {autopilot.lockedReason ? (
          <p className="sa-inverted rounded-lg px-4 py-3 font-semibold">{autopilot.lockedReason}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {autopilot.categories.map((c) => (
              <li key={c.category} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{categoryLabels[c.category]}</span>
                  <span className={c.on ? "font-black" : "text-muted-foreground"}>
                    {c.on ? "On" : "Off"}
                  </span>
                </div>
                {c.on ? (
                  <form action={setAutopilotAction}>
                    <input type="hidden" name="category" value={c.category} />
                    <input type="hidden" name="on" value="0" />
                    <Button type="submit" variant="outline" className="w-full">
                      Turn off
                    </Button>
                  </form>
                ) : c.canTurnOn ? (
                  <details className="rounded-lg border">
                    <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
                      Turn on
                    </summary>
                    <form action={setAutopilotAction} className="flex flex-col gap-2 px-4 pb-4">
                      <input type="hidden" name="category" value={c.category} />
                      <input type="hidden" name="on" value="1" />
                      <p>
                        Replies like these will send on their own after {GRACE_MINUTES} minutes,
                        unless you hold them.
                      </p>
                      <Button type="submit" className="w-full">
                        Yes, send these on their own
                      </Button>
                    </form>
                  </details>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Unlocks after {EARN_THRESHOLD} replies you sent without changing them (
                    {Math.min(c.earned, EARN_THRESHOLD)} so far).
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsScreen>
  );
}
