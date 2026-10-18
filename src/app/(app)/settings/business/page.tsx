import type { Metadata } from "next";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { hicExpiryLine } from "@/config/licenses";
import { depositTermsWarning } from "@/server/deposit-rules";
import { cn } from "@/lib/utils";
import { AutoSaveForm } from "@/components/forms/auto-save-form";
import { hourLabel, workHoursOf } from "@/server/business-hours-rules";
import { getBusinessProfile, WORK_DAY_NAMES } from "@/server/profile";
import { describeProfileFacts, type ProfileFactRow } from "@/server/profile-facts";
import { activeNotes, MAX_ACTIVE_NOTES, NOTE_MAX_CHARS, ownerToday } from "@/server/seasonal-notes";
import { requireOwner } from "@/server/session";
import { SettingsScreen } from "../screen";
import { saveWorkHoursAction } from "../profile-actions";
import { removeSeasonalNoteAction } from "../wording-actions";
import { untilLine } from "@/lib/plain-date";
import { SeasonalNoteForm } from "./seasonal-note-form";

export const metadata: Metadata = { title: "Your business" };

/** One fact: its name and a Change link on one line, the saved value (or what "not set" means). */
function FactRow({ fact }: { fact: ProfileFactRow }) {
  return (
    <li className="flex flex-col gap-0.5 border-b py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{fact.label}</span>
        <Link
          href={`/settings/profile#${fact.field}`}
          className="inline-flex min-h-tap items-center px-2 font-semibold underline underline-offset-4"
        >
          Change<span className="sr-only"> {fact.label.toLowerCase()}</span>
        </Link>
      </div>
      <span
        className={cn(
          "line-clamp-4 break-words whitespace-pre-line",
          fact.value ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {fact.value ?? fact.emptyNote}
      </span>
    </li>
  );
}

export default async function BusinessSettingsPage(props: PageProps<"/settings/business">) {
  const { workspace } = await requireOwner();
  const now = new Date();
  const [profile, notes, today] = await Promise.all([
    getBusinessProfile(workspace.id),
    activeNotes(workspace.id, now),
    ownerToday(workspace.id, now),
  ]);
  // Check 15 P4: every saved fact, each with a Change link to its own box.
  const facts = describeProfileFacts(profile, workspace);
  const bookingOut = facts.find((f) => f.field === "leadTime")!;
  const profileFacts = facts.filter((f) => f.field !== "leadTime");
  // Check 38 P6: one line when the HIC registration runs out within 30 days. No email.
  const hicLine = hicExpiryLine(profile?.licenses, today);
  // Check 38 P2: an MA shop whose payment terms ask for more than a one-third deposit.
  const depositLine = depositTermsWarning(profile?.state, profile?.paymentTerms);
  const work = workHoursOf(profile);
  const ownNotes = notes.filter((n) => !n.away);
  const awayNote = notes.find((n) => n.away);

  return (
    <SettingsScreen
      path="/settings/business"
      heavy="your business."
      params={await props.searchParams}
    >
      {/* Check 15 P4: the two things that change most sit at the top. */}
      <section aria-label="Booking out">
        <ul className="flex flex-col rounded-xl border bg-card px-4 py-2">
          <FactRow fact={bookingOut} />
        </ul>
      </section>

      <section aria-labelledby="seasonal-notes-heading" className="flex flex-col gap-3">
        <h2 id="seasonal-notes-heading" className="text-xl font-black">
          Seasonal notes
        </h2>
        <p className="text-muted-foreground">
          Short notes your drafts can mention until their last day, like “Booked through November”
          or “On vacation Aug 1 to 10, back Aug 11”. Up to {MAX_ACTIVE_NOTES} at a time. Each one
          disappears after its last day.
        </p>
        {awayNote ? (
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
            <span className="font-semibold">{awayNote.text}</span>
            <Link
              href="/settings/away"
              className="text-sm font-semibold underline underline-offset-4"
            >
              Change it in Away mode
            </Link>
          </div>
        ) : null}
        {ownNotes.length ? (
          <ul className="flex flex-col gap-2">
            {ownNotes.map((n) => (
              <li key={n.id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <div className="flex flex-1 flex-col">
                  <span className="font-semibold">{n.text}</span>
                  <span className="text-sm text-muted-foreground">
                    {untilLine(n.endsOn, today)}
                  </span>
                </div>
                <form action={removeSeasonalNoteAction}>
                  <input type="hidden" name="id" value={n.id} />
                  <Button type="submit" variant="outline" aria-label={`Remove note: ${n.text}`}>
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        {ownNotes.length < MAX_ACTIVE_NOTES ? (
          <SeasonalNoteForm today={today} maxChars={NOTE_MAX_CHARS} />
        ) : null}
      </section>

      <section aria-labelledby="business" className="flex flex-col gap-3">
        <h2 id="business" className="text-xl font-black">
          Business profile
        </h2>
        {profile?.completedAt ? null : (
          <p className="text-muted-foreground">Not filled in yet. Drafts are better when it is.</p>
        )}
        <ul className="flex flex-col rounded-xl border bg-card px-4 py-2">
          {profileFacts.map((f) => (
            <FactRow key={f.field} fact={f} />
          ))}
        </ul>
        {depositLine ? (
          <p role="status" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
            {depositLine}
          </p>
        ) : null}
        {hicLine ? (
          <p role="status" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
            {hicLine}
          </p>
        ) : null}
        <Link
          href="/settings/profile"
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Edit business profile
        </Link>
      </section>

      {/* Check 15 P8: the hours the lead-waiting alerts count. */}
      <section aria-labelledby="work-hours-heading" className="flex flex-col gap-3">
        <h2 id="work-hours-heading" className="text-xl font-black">
          Your working days (for alerts)
        </h2>
        <p className="text-muted-foreground">
          Alerts about waiting leads only count these hours. Your description above is what drafts
          say.
        </p>
        <AutoSaveForm action={saveWorkHoursAction} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="font-semibold">Days</legend>
            <div className="grid grid-cols-4 gap-x-2 gap-y-2 sm:grid-cols-7">
              {WORK_DAY_NAMES.map((name, i) => (
                <label key={name} className="flex min-h-tap items-center gap-2">
                  <input
                    type="checkbox"
                    name="days"
                    value={i + 1}
                    defaultChecked={work.days.includes(i + 1)}
                    className="size-5 shrink-0"
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Start</span>
              <select
                name="startHour"
                defaultValue={String(work.startHour)}
                className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">End</span>
              <select
                name="endHour"
                defaultValue={String(work.endHour)}
                className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
              >
                {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button type="submit" variant="outline" className="w-full">
            Save working days
          </Button>
        </AutoSaveForm>
      </section>
    </SettingsScreen>
  );
}
