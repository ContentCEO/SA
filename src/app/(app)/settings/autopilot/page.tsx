import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { categoryLabels } from "@/config/categories";
import { autopilotState, EARN_THRESHOLD, GRACE_MINUTES } from "@/server/autopilot";
import { planHasAutopilot } from "@/config/pricing";
import { getBusinessProfile } from "@/server/profile";
import { autopilotFreeMonthLine, freeMonthRunning } from "@/server/referral-rules";
import { requireOwner } from "@/server/session";
import { setAutopilotAction } from "../profile-actions";
import { SettingsScreen } from "../screen";

export const metadata: Metadata = { title: "Autopilot" };

export default async function AutopilotSettingsPage(props: PageProps<"/settings/autopilot">) {
  const { workspace } = await requireOwner();
  const now = new Date();
  const autopilot = await autopilotState(workspace, now);
  // Plan #47: a running free month whose plan adds autopilot says when that ends.
  const autopilotNote =
    freeMonthRunning(workspace, now) &&
    workspace.freePlan &&
    workspace.freePlanUntil &&
    planHasAutopilot(workspace.freePlan) &&
    !planHasAutopilot(workspace.plan)
      ? autopilotFreeMonthLine(
          workspace.freePlan,
          workspace.freePlanUntil,
          (await getBusinessProfile(workspace.id))?.timeZone,
        )
      : null;
  return (
    <SettingsScreen path="/settings/autopilot" heavy="autopilot." params={await props.searchParams}>
      <section aria-labelledby="autopilot-heading" className="flex flex-col gap-3">
        <h2 id="autopilot-heading" className="sr-only">
          Autopilot
        </h2>
        <p className="text-muted-foreground">
          Lets Squared Away send replies on its own for the kinds of email you choose. Off until you
          turn it on. Even then, it never sends complaints, any reply that mentions a dollar amount
          or an invoice email that names one, anything flagged for you, follow-ups, replies to
          people you haven&apos;t written to before, or replies that go to a different address than
          the email came from (as a website form&apos;s do) — and each one waits {GRACE_MINUTES}{" "}
          minutes in your queue so you can hold it.
        </p>
        {autopilotNote && !autopilot.lockedReason ? (
          <p className="font-semibold">{autopilotNote}</p>
        ) : null}
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
