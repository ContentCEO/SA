import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { TimeZoneInput } from "@/components/forms/time-zone-input";
import { autopilotState } from "@/server/autopilot";
import { awayState } from "@/server/away";
import {
  addDays,
  AWAY_MAX_DAYS,
  awayLastLine,
  awayUntilWords,
  backOnWords,
} from "@/server/away-rules";
import { activeNotes } from "@/server/seasonal-notes";
import { isReadOnly } from "@/server/lifecycle";
import { requireOwner } from "@/server/session";
import { SettingsScreen } from "../screen";
import { turnAwayOffAction, turnAwayOnAction } from "../away-actions";

export const metadata: Metadata = { title: "Away mode" };

/** Ideas E7: going on vacation, or off on a long job. Nothing ever answers for the owner. */
export default async function AwayPage(props: PageProps<"/settings/away">) {
  const { workspace } = await requireOwner();
  const now = new Date();
  const [away, autopilot, notes] = await Promise.all([
    awayState(workspace.id, now),
    autopilotState(workspace, now),
    activeNotes(workspace.id, now),
  ]);
  const autopilotOn = autopilot.categories.some((c) => c.on);
  const note = notes.find((n) => n.away);
  const readOnly = isReadOnly(workspace);

  return (
    <SettingsScreen path="/settings/away" heavy="away mode." params={await props.searchParams}>
      {away.on && away.backOn ? (
        <section className="flex flex-col gap-3">
          <p className="text-lg font-black">
            You&apos;re away until {awayUntilWords(away.backOn)}. Back {backOnWords(away.backOn)}.
          </p>
          {note ? (
            <p className="text-muted-foreground">
              Replies we write can use this: &ldquo;{note.text}&rdquo;
            </p>
          ) : null}
          <form action={turnAwayOffAction}>
            <Button type="submit" className="w-full">
              I&apos;m back — turn it off
            </Button>
          </form>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <p>Going on vacation or off on a long job? Turn this on and:</p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>follow-up nudges pause until you&apos;re back,</li>
            <li>replies we write can tell customers when you&apos;re back,</li>
            <li>{awayLastLine(autopilotOn)}</li>
          </ul>
          {readOnly ? null : (
            <form action={turnAwayOnAction} className="flex flex-col gap-3">
              <TimeZoneInput fallback={away.timeZone} />
              <label className="flex flex-col gap-1.5">
                <span className="font-semibold">I&apos;m back on</span>
                <input
                  name="backOn"
                  type="date"
                  required
                  min={addDays(away.today, 1)}
                  max={addDays(away.today, AWAY_MAX_DAYS)}
                  className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
                />
              </label>
              <Button type="submit" className="w-full">
                Turn on away mode
              </Button>
            </form>
          )}
        </section>
      )}
      <p className="text-muted-foreground">
        Morning emails and alerts keep coming. Turn them off in Settings if you want quiet. Nudges
        pick up again when you&apos;re back, for anything still recent.
      </p>
    </SettingsScreen>
  );
}
