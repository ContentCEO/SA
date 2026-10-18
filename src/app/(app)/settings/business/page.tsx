import type { Metadata } from "next";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { hicExpiryLine } from "@/config/licenses";
import { depositTermsWarning } from "@/server/deposit-rules";
import { cn } from "@/lib/utils";
import { getBusinessProfile } from "@/server/profile";
import { describeProfileFacts, type ProfileFactRow } from "@/server/profile-facts";
import { activeNotes, MAX_ACTIVE_NOTES, NOTE_MAX_CHARS, ownerToday } from "@/server/seasonal-notes";
import { requireOwner } from "@/server/session";
import { SettingsScreen } from "../screen";
import { addSeasonalNoteAction, removeSeasonalNoteAction } from "../wording-actions";

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
          Short notes drafts can mention until their last day — “Booked through November”, “On
          vacation Aug 1–10, back Aug 11”. Up to {MAX_ACTIVE_NOTES} at a time. They disappear on
          their own.
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
                  <span className="text-sm text-muted-foreground">Until {n.endsOn}</span>
                </div>
                <form action={removeSeasonalNoteAction}>
                  <input type="hidden" name="id" value={n.id} />
                  <Button type="submit" variant="ghost" aria-label={`Remove note: ${n.text}`}>
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        {ownNotes.length < MAX_ACTIVE_NOTES ? (
          <form action={addSeasonalNoteAction} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Note</span>
              <input
                name="text"
                required
                maxLength={NOTE_MAX_CHARS}
                placeholder="Booked through November"
                className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Last day it applies</span>
              <input
                name="endsOn"
                type="date"
                required
                min={today}
                className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
              />
            </label>
            <Button type="submit" variant="outline" className="w-full">
              Add note
            </Button>
          </form>
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
    </SettingsScreen>
  );
}
