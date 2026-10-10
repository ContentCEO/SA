import Link from "next/link";
import { signOut } from "@/auth";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button, buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import { listMailboxes, mailboxLimit, type MailboxSummary } from "@/server/mailboxes";
import { BACKFILL_DAYS, syncSummary } from "@/server/sync";
import { isAdminEmail } from "@/server/admin";
import { autopilotState, EARN_THRESHOLD, GRACE_MINUTES } from "@/server/autopilot";
import { requireOwner } from "@/server/session";
import { categoryLabels } from "@/config/categories";
import { cn } from "@/lib/utils";
import {
  describeVoice,
  DIGEST_HOURS,
  FOLLOWUP_DAY_CHOICES,
  getBusinessProfile,
  getVoiceProfile,
} from "@/server/profile";
import { DeleteAccountButton } from "./delete-account-button";
import { mailboxHealth } from "@/server/mailbox-health";
import { activeNotes, MAX_ACTIVE_NOTES, NOTE_MAX_CHARS, ownerToday } from "@/server/seasonal-notes";
import {
  addSeasonalNoteAction,
  removeSeasonalNoteAction,
  saveNeverSayAction,
} from "./wording-actions";
import {
  confirmSmsCodeAction,
  removeSmsPhoneAction,
  sendSmsCodeAction,
  toggleSmsAlertsAction,
} from "./sms-actions";
import { smsConfigured } from "@/lib/sms";
import { formatUsPhone } from "@/server/sms-alerts";
import { DisconnectButton } from "./disconnect-button";
import {
  relearnVoiceAction,
  saveDigestSettingsAction,
  setAutopilotAction,
  saveFollowupSettingsAction,
} from "./profile-actions";
import { TimeZoneInput } from "@/components/forms/time-zone-input";
import { GetTheApp } from "@/components/app/get-the-app";

const done: Record<string, string> = {
  connected: "Gmail connected.",
  disconnected: "Gmail disconnected. We've removed our access at Google.",
  profile: "Business profile saved.",
  voice: "Saved how you write.",
  followups: "Follow-up settings saved.",
  digest: "Morning summary saved.",
  sms_code: "Code sent. Type it in below.",
  never_say: "Never-say list saved.",
  note_added: "Note added. Drafts will use it until its last day.",
  note_removed: "Note removed.",
  sms_on: "Text alerts are on.",
  sms_off: "Text alerts are off.",
  sms_removed: "Number removed.",
  autopilot_on: "Autopilot is on for that kind of email. You'll get 10 minutes to hold each one.",
  autopilot_off: "Autopilot is off for that kind of email. Those replies wait for your tap again.",
  relearn: "Re-reading your sent mail. This takes a minute or two.",
};

const errors: Record<string, string> = {
  note_invalid: "Write a short note and pick its last day.",
  note_past: "That date has already passed.",
  note_too_far: "Pick a date within the next year.",
  note_full: "You can have 5 notes at once. Remove one first.",
  sms_phone: "That doesn't look like a US mobile number.",
  sms_busy: "Too many tries. Wait an hour and try again.",
  sms_code: "That code didn't match, or it expired. Send a new one.",
  sms_not_configured: "Texting isn't switched on yet.",
  sms_not_verified: "Confirm your number first.",
  relearn_busy: "Your sent mail was re-read recently. You can do it again tomorrow.",
  delete_billing:
    "We couldn't cancel your plan, so nothing was deleted. Try again, or call us and we'll do it.",
  autopilot: "Autopilot can't be turned on for that yet.",
  limit: "Your plan is at its mailbox limit. Disconnect one first, or ask about a bigger plan.",
  unknown: "That didn't work. Refresh and try again.",
};

const statusWords = {
  active: "Connected",
  reconnect_needed: "Needs reconnecting",
  paused: "Paused",
} as const;

function syncLine(m: MailboxSummary, messageCount: number): string {
  if (m.status === "reconnect_needed") {
    return "Google access was removed, so Squared Away has stopped reading this inbox. Reconnect to pick up where it left off.";
  }
  if (m.status === "paused") return "Paused. Nothing is being read or drafted.";
  if (!m.backfillCompletedAt) {
    return `Reading your last ${BACKFILL_DAYS} days of email. This can take a few minutes.`;
  }
  const checked = m.lastSyncedAt ? `, checked ${relativeTime(m.lastSyncedAt)}` : "";
  return `${messageCount.toLocaleString("en-US")} emails from the last ${BACKFILL_DAYS} days${checked}.`;
}

export default async function SettingsPage(props: PageProps<"/settings">) {
  const { workspace, session } = await requireOwner();
  const admin = isAdminEmail(session?.user?.email);
  const now = new Date();
  const mailboxes = await listMailboxes(workspace.id);
  const counts = new Map(
    await Promise.all(
      mailboxes.map(async (m) => [m.id, (await syncSummary(m.id)).messageCount] as const),
    ),
  );
  const params = await props.searchParams;
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const canAddMore = mailboxes.length < mailboxLimit(workspace);
  const [profile, voice, autopilot, notes, today] = await Promise.all([
    getBusinessProfile(workspace.id),
    getVoiceProfile(workspace.id),
    autopilotState(workspace),
    activeNotes(workspace.id, now),
    ownerToday(workspace.id, now),
  ]);
  const profileFacts = [
    ["Business", workspace.businessName],
    ["Work", profile?.services],
    ["Area", profile?.serviceArea],
    ["Never promise", profile?.doNotPromise.length ? profile.doNotPromise.join(" · ") : null],
    ["Always send me", profile?.vipSenders.length ? profile.vipSenders.join(", ") : null],
    [
      "Flag amounts over",
      profile ? `$${profile.amountThresholdDollars.toLocaleString("en-US")}` : null,
    ],
  ].filter((f): f is [string, string] => Boolean(f[1]));
  const voiceLine =
    voice?.status === "ready"
      ? describeVoice(voice)
      : voice?.status === "learning"
        ? "Reading your sent mail to learn how you write…"
        : voice?.status === "not_enough_mail"
          ? "Not enough sent mail to learn from yet. You can describe it yourself."
          : voice?.status === "failed"
            ? "Couldn't learn your style last time. You can describe it yourself, or try again."
            : "Not learned yet. It starts once your email has been read.";

  return (
    <>
      <Headline serif="your shop," heavy="your settings." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <section aria-labelledby="mailbox" className="flex flex-col gap-4">
        <h2 id="mailbox" className="text-xl font-black">
          Your Gmail
        </h2>

        {mailboxes.length === 0 ? (
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <p className="text-lg">No Gmail connected yet.</p>
            <Link href="/connect" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
              Connect Gmail
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {mailboxes.map((m) => {
              const health = mailboxHealth(m, now, Boolean(process.env.GMAIL_PUBSUB_TOPIC));
              const needsYou = health.needsReconnect;
              return (
                <li
                  key={m.id}
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border p-4",
                    needsYou ? "sa-inverted" : "bg-card",
                  )}
                >
                  <div className="flex flex-col">
                    <span className="text-lg font-semibold break-all">{m.email}</span>
                    <span className={cn(needsYou ? "font-black" : "text-muted-foreground")}>
                      {statusWords[m.status]}
                    </span>
                    <span className={cn("mt-1", needsYou ? "" : "text-muted-foreground")}>
                      {syncLine(m, counts.get(m.id) ?? 0)}
                    </span>
                  </div>
                  <dl aria-label={`Health of ${m.email}`} className="flex flex-col gap-1.5">
                    {health.lines.map((l) => (
                      <div key={l.label} className="flex flex-col">
                        <dt className="text-sm opacity-80">{l.label}</dt>
                        <dd className={l.problem ? "font-black" : undefined}>{l.text}</dd>
                      </div>
                    ))}
                  </dl>
                  {needsYou ? (
                    <Link href="/connect" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
                      Reconnect Gmail
                    </Link>
                  ) : null}
                  <DisconnectButton mailboxId={m.id} email={m.email} />
                </li>
              );
            })}
          </ul>
        )}

        {mailboxes.length > 0 && canAddMore ? (
          <Link
            href="/connect"
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            Connect another Gmail
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="business" className="flex flex-col gap-3">
        <h2 id="business" className="text-xl font-black">
          Business profile
        </h2>
        {profileFacts.length ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border bg-card p-4">
            {profileFacts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-semibold">{k}</dt>
                <dd className="line-clamp-3 break-words text-muted-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground">Not filled in yet. Drafts are better when it is.</p>
        )}
        <Link
          href="/settings/profile"
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Edit business profile
        </Link>
      </section>

      <section aria-labelledby="voice" className="flex flex-col gap-3">
        <h2 id="voice" className="text-xl font-black">
          How you write
        </h2>
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <p className="text-lg">{voiceLine}</p>
          {voice?.status === "ready" && voice.phrasesUsed.length ? (
            <p className="text-muted-foreground">
              You say things like “{voice.phrasesUsed.slice(0, 3).join("”, “")}”.
            </p>
          ) : null}
          {voice?.status === "ready" && voice.phrasesAvoided.length ? (
            <p className="text-muted-foreground">
              Drafts will never say “{voice.phrasesAvoided.slice(0, 2).join("” or “")}”.
            </p>
          ) : null}
          {voice?.examples.length ? (
            <details>
              <summary className="inline-flex min-h-tap cursor-pointer items-center font-semibold">
                Sample replies in your style
              </summary>
              <ul className="mt-2 flex flex-col gap-3">
                {voice.examples.map((ex, i) => (
                  <li key={i} className="rounded-lg border bg-paper p-3 whitespace-pre-line">
                    {ex}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {voice?.source === "edited" ? (
            <p className="text-sm text-muted-foreground">
              You edited this, so the weekly refresh leaves it alone.
            </p>
          ) : null}
        </div>
        <Link
          href="/settings/voice"
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Edit how I write
        </Link>
        {mailboxes.some((m) => m.status === "active") ? (
          <form action={relearnVoiceAction}>
            <Button type="submit" variant="ghost" className="w-full">
              Re-learn from my sent mail
            </Button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="followups" className="flex flex-col gap-3">
        <h2 id="followups" className="text-xl font-black">
          Follow-ups
        </h2>
        <form action={saveFollowupSettingsAction} className="flex flex-col gap-3">
          <label className="flex min-h-tap items-center gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={profile?.followupsEnabled ?? true}
              className="size-6 accent-charcoal"
            />
            <span className="font-semibold">Nudge quotes and invoices that go quiet</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Wait this long for a reply</span>
            <select
              name="days"
              defaultValue={String(profile?.followupDays ?? 3)}
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            >
              {FOLLOWUP_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <p className="text-muted-foreground">
            A nudge is a draft in your queue, like any other reply — nothing sends without you.
            Never more than two per conversation, and never for complaints.
          </p>
          <Button type="submit" variant="outline" className="w-full">
            Save follow-ups
          </Button>
        </form>
      </section>

      <section aria-labelledby="app-heading" className="flex flex-col gap-3">
        <h2 id="app-heading" className="text-xl font-black">
          Get the app
        </h2>
        <p className="text-muted-foreground">
          Put Squared Away on your home screen. It opens straight to your queue, full screen, with
          the same login.
        </p>
        <GetTheApp />
      </section>

      <section id="never-say" aria-labelledby="never-say-heading" className="flex flex-col gap-3">
        <h2 id="never-say-heading" className="text-xl font-black">
          Never say this
        </h2>
        <p className="text-muted-foreground">
          Words and phrases your drafts must never use — one per line. If one slips in, the draft is
          rewritten once, then flagged for you. You can also select words while editing a draft and
          tap Never say this.
        </p>
        <form action={saveNeverSayAction} className="flex flex-col gap-3">
          <textarea
            name="neverSay"
            aria-label="Your never-say list"
            defaultValue={(profile?.neverSay ?? []).join("\n")}
            rows={4}
            placeholder={"No worries\nPer my last email"}
            className="w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base"
          />
          <Button type="submit" variant="outline" className="w-full">
            Save never-say list
          </Button>
        </form>
      </section>

      <section
        id="seasonal-notes"
        aria-labelledby="seasonal-notes-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="seasonal-notes-heading" className="text-xl font-black">
          Seasonal notes
        </h2>
        <p className="text-muted-foreground">
          Short notes drafts can mention until their last day — “Booked through November”, “On
          vacation Aug 1–10, back Aug 11”. Up to {MAX_ACTIVE_NOTES} at a time. They disappear on
          their own.
        </p>
        {notes.length ? (
          <ul className="flex flex-col gap-2">
            {notes.map((n) => (
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
        {notes.length < MAX_ACTIVE_NOTES ? (
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

      <section id="digest" aria-labelledby="digest-heading" className="flex flex-col gap-3">
        <h2 id="digest-heading" className="text-xl font-black">
          Morning summary
        </h2>
        <form action={saveDigestSettingsAction} className="flex flex-col gap-3">
          <label className="flex min-h-tap items-center gap-3">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={profile?.digestEnabled ?? true}
              className="size-6 accent-charcoal"
            />
            <span className="font-semibold">Email me a summary each morning</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Send it at</span>
            <select
              name="hour"
              defaultValue={String(profile?.digestHour ?? 7)}
              className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
            >
              {DIGEST_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h}:00 am
                </option>
              ))}
            </select>
          </label>
          <TimeZoneInput fallback={profile?.timeZone ?? "America/New_York"} />
          <p className="text-muted-foreground">
            Just counts — how many replies are waiting and what needs you. No customer names or
            email text go in it. Skipped on mornings with nothing to say.
          </p>
          <Button type="submit" variant="outline" className="w-full">
            Save morning summary
          </Button>
        </form>
      </section>

      <section id="texts" aria-labelledby="texts-heading" className="flex flex-col gap-3">
        <h2 id="texts-heading" className="text-xl font-black">
          Text alerts
        </h2>
        <p className="text-muted-foreground">
          A text when a new quote request or an email that needs you comes in. Just the count and a
          link — never a customer&apos;s name or words. Not between 9pm and 7am, at most one every
          10 minutes. Reply STOP any time.
        </p>
        {!smsConfigured() ? (
          <p className="font-semibold">Text alerts aren&apos;t switched on yet. Coming soon.</p>
        ) : profile?.alertPhoneVerifiedAt && profile.alertPhone ? (
          <div className="flex flex-col gap-3">
            <p>
              Texts go to <span className="font-semibold">{formatUsPhone(profile.alertPhone)}</span>
              .
            </p>
            <form action={toggleSmsAlertsAction}>
              <input type="hidden" name="enabled" value={profile.smsAlertsEnabled ? "off" : "on"} />
              <Button type="submit" variant="outline" className="w-full">
                {profile.smsAlertsEnabled ? "Turn off text alerts" : "Turn on text alerts"}
              </Button>
            </form>
            <form action={removeSmsPhoneAction}>
              <Button type="submit" variant="ghost" className="w-full">
                Remove my number
              </Button>
            </form>
          </div>
        ) : profile?.smsCodeExpiresAt && profile.smsCodeExpiresAt > new Date() ? (
          <form action={confirmSmsCodeAction} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">
                The 6-digit code we texted to {formatUsPhone(profile.alertPhone!)}
              </span>
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                className="min-h-tap rounded-lg border border-input bg-paper px-3 text-lg tracking-widest"
              />
            </label>
            <Button type="submit" className="w-full">
              Confirm my number
            </Button>
          </form>
        ) : (
          <form action={sendSmsCodeAction} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Your mobile number</span>
              <input
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(508) 555-1234"
                required
                className="min-h-tap rounded-lg border border-input bg-paper px-3 text-base"
              />
            </label>
            <Button type="submit" className="w-full">
              Text me a code
            </Button>
          </form>
        )}
      </section>

      <section id="autopilot" aria-labelledby="autopilot-heading" className="flex flex-col gap-3">
        <h2 id="autopilot-heading" className="text-xl font-black">
          Autopilot
        </h2>
        <p className="text-muted-foreground">
          Lets Squared Away send replies on its own for the kinds of email you choose. Off until you
          turn it on. Even then, it never sends complaints, anything about money, anything flagged
          for you, follow-ups, or replies to people you haven&apos;t written to before — and each
          one waits {GRACE_MINUTES} minutes in your queue so you can hold it.
        </p>
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

      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="text-xl font-black">
          Account
        </h2>
        <Link href="/billing" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
          Plan &amp; billing
        </Link>
        {admin ? (
          <Link href="/admin" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
            Admin
          </Link>
        ) : null}
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
        <DeleteAccountButton hasPlan={Boolean(workspace.stripeSubscriptionId)} />
      </section>
    </>
  );
}
