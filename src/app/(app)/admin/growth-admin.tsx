import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";
import { GROWTH_SERVICES, growthServiceLabel, type GrowthService } from "@/config/growth";
import { relativeTime } from "@/lib/relative-time";
import {
  CHECK_IN_FIELDS,
  formatCents,
  GROWTH_BODY_MAX,
  GROWTH_NOTE_MAX,
  GROWTH_STATUS_LABEL,
  GROWTH_TIME_ZONES,
  GROWTH_TITLE_MAX,
  longDate,
  monthLabel,
  recentMonths,
  type GrowthMove,
  type GrowthStatus,
} from "@/server/growth-client-rules";
import type { growthAccountChoices, listGrowthAdmin } from "@/server/growth-clients";
import type { GrowthRequest } from "@/server/growth-note";
import {
  emailGrowthUpdateAction,
  inviteToGrowthAction,
  moveGrowthAction,
  postGrowthUpdateAction,
  removeGrowthRequestAction,
  saveGrowthMonthAction,
  startGrowthAction,
  changeGrowthAction,
} from "./growth-actions";

/**
 * /admin's Squared Away Growth parts (Davi, 2026-10-16): the "Growth clients" card and the
 * Growth controls on a waitlist card. Shows only what Davi entered: Growth never uses inbox
 * data (no email content, customer names, counts or totals from the inbox app).
 */

export const GROWTH_DONE: Record<string, string> = {
  growth_started: "Growth started. They see the Growth dashboard after they sign in.",
  growth_restarted: "Growth started again for that account.",
  growth_changed: "Saved.",
  growth_pause: "Growth paused. Their dashboard says so.",
  growth_resume: "Growth resumed.",
  growth_end: "Growth ended. Their dashboard is closed; what you entered is kept.",
  growth_posted_emailed: "Update posted, and they were emailed that there's a new one.",
  growth_posted_no_email:
    "Update posted. Email isn't set up, so nobody was emailed. It's on their dashboard.",
  growth_posted_unsent:
    "Update posted, but the email didn't go out. Tap Email it to them to try again.",
  growth_emailed: "Emailed.",
  growth_already_emailed: "That update was already emailed. Nothing was sent again.",
  growth_month_saved: "Numbers saved. They show on their dashboard.",
  growth_month_cleared: "That month's numbers were removed.",
  growth_invited_emailed: "Invited to Growth, and emailed the sign-in link.",
  growth_invited:
    "Invited to Growth. The email didn't go out (email isn't set up, or it failed), so tell them yourself.",
  growth_invite_updated: "Their Growth invite now has these services and start date.",
};

export const GROWTH_ERRORS: Record<string, string> = {
  growth_input: "Pick at least one service and a real start date (no more than a year ahead).",
  growth_already: "That account is already a Growth client.",
  growth_not_found: "That account or client isn't there any more. Refresh and look again.",
  growth_status: "That change isn't allowed from where this client is now. Refresh and look again.",
  growth_update_input: `Give the update a title (up to ${GROWTH_TITLE_MAX} characters) and some text (up to ${GROWTH_BODY_MAX}).`,
  growth_ended: "Growth has ended for this client, so updates can't be posted.",
  growth_email_off: "Email isn't set up yet, so nothing was sent.",
  growth_email_failed: "The email didn't go out. Try again in a minute.",
  growth_month_input: `Use whole numbers, dollar amounts like 1200 or 1,200.50, a month up to this one, and a note up to ${GROWTH_NOTE_MAX} characters.`,
  growth_has_account:
    "That address already has an account. Use Start Growth for this account instead.",
};

export const WAITLIST_GROWTH_DONE: Record<string, string> = {
  wl_growth_invited_emailed: "Invited to Growth, and emailed the sign-in link.",
  wl_growth_invited:
    "Invited to Growth. The email didn't go out (email isn't set up, or it failed), so tell them yourself.",
  wl_growth_invite_updated: "Their Growth invite now has these services and start date.",
  wl_growth_request_deleted: "Removed. That Growth request and everything they typed are gone.",
  wl_growth_request_block_removed:
    "Removed the Growth request. Their app waitlist sign-up is still there.",
};

export const WAITLIST_GROWTH_ERRORS: Record<string, string> = {
  wl_growth_input: "Pick at least one service and a real start date (no more than a year ahead).",
  wl_growth_has_account:
    "That address already has an account. Use Start Growth for this account in Growth clients.",
  wl_growth_no_request: "There's no Growth request on that entry any more. Refresh and look again.",
};

const field = "min-h-tap rounded-lg border border-input bg-paper px-3 text-base";

function ServicesField({ checked }: { checked: readonly GrowthService[] }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-semibold">Services</legend>
      {GROWTH_SERVICES.map((s) => (
        <label key={s.value} className="flex min-h-tap items-center gap-3">
          <input
            type="checkbox"
            name="services"
            value={s.value}
            defaultChecked={checked.includes(s.value)}
            className="size-5"
          />
          {s.label}
        </label>
      ))}
    </fieldset>
  );
}

function StartField({ value }: { value: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-semibold">Start date</span>
      <input name="startedOn" type="date" required defaultValue={value} className={field} />
    </label>
  );
}

function TimeZoneField({ value }: { value: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-semibold">Their time zone (for the months on their dashboard)</span>
      <select name="timeZone" defaultValue={value} className={field}>
        {GROWTH_TIME_ZONES.map((z) => (
          <option key={z.value} value={z.value}>
            {z.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Confirm({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
        {summary}
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">{children}</div>
    </details>
  );
}

const MOVES: Record<
  GrowthStatus,
  { move: GrowthMove; label: string; explain: string; confirm: string }[]
> = {
  active: [
    {
      move: "pause",
      label: "Pause Growth",
      explain: "Their dashboard stays open and says Growth is paused.",
      confirm: "Yes, pause Growth",
    },
    {
      move: "end",
      label: "End Growth",
      explain:
        "Closes their Growth dashboard. Their updates and numbers are kept, and Start Growth for this account opens it again.",
      confirm: "Yes, end Growth",
    },
  ],
  paused: [
    {
      move: "resume",
      label: "Resume Growth",
      explain: "Back to active. Their dashboard stops saying Growth is paused.",
      confirm: "Yes, resume Growth",
    },
    {
      move: "end",
      label: "End Growth",
      explain:
        "Closes their Growth dashboard. Their updates and numbers are kept, and Start Growth for this account opens it again.",
      confirm: "Yes, end Growth",
    },
  ],
  ended: [],
};

const centsInput = (c: number | null) =>
  c === null ? "" : Number.isInteger(c / 100) ? String(c / 100) : (c / 100).toFixed(2);

type Client = Awaited<ReturnType<typeof listGrowthAdmin>>["clients"][number];
type Month = Client["months"][number];

function monthLine(m: Month): string {
  const parts = CHECK_IN_FIELDS.flatMap((f) => {
    const v = m[f.key];
    if (v === null) return [];
    const label = f.label.replace(" ($)", "").toLowerCase();
    return [f.money ? `${formatCents(v)} ${label}` : `${v.toLocaleString("en-US")} ${label}`];
  });
  return parts.length ? parts.join(" · ") : "Only a note";
}

function MonthForm({
  clientId,
  month,
  months,
  values,
}: {
  clientId: string;
  /** Fixed for an existing month; a choice for a new one. */
  month?: string;
  months?: string[];
  values?: Month;
}) {
  return (
    <form action={saveGrowthMonthAction} className="flex flex-col gap-3">
      <input type="hidden" name="clientId" value={clientId} />
      {month ? (
        <input type="hidden" name="month" value={month} />
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">Month</span>
          <select name="month" className={field} defaultValue={months?.[0]}>
            {(months ?? []).map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-2 gap-3">
        {CHECK_IN_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1.5">
            <span className="font-semibold">{f.label}</span>
            <input
              name={f.form}
              inputMode={f.money ? "decimal" : "numeric"}
              autoComplete="off"
              defaultValue={
                values ? (f.money ? centsInput(values[f.key]) : (values[f.key] ?? "")) : ""
              }
              className={field}
            />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">Note (optional, shown to you only)</span>
        <input
          name="note"
          maxLength={GROWTH_NOTE_MAX}
          defaultValue={values?.note ?? ""}
          className={field}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Leave a box empty if you didn&apos;t check that number. Emptying every box removes the
        month.
      </p>
      <Button type="submit" className="w-full">
        Save numbers
      </Button>
    </form>
  );
}

function ClientCard({ c, today, now }: { c: Client; today: string; now: Date }) {
  const status = c.status as GrowthStatus;
  const thisMonth = today.slice(0, 7);
  const newMonths = recentMonths(thisMonth, 13).filter((m) => !c.months.some((x) => x.month === m));
  return (
    <article
      aria-label={`Growth client: ${c.label}`}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-lg font-black">{c.label}</span>
          {c.label !== c.ownerEmail ? (
            <span className="truncate text-sm">{c.ownerEmail}</span>
          ) : null}
        </div>
        <span
          className={
            status === "active"
              ? "rounded-md border-2 border-charcoal px-2 py-1 text-sm font-black"
              : "sa-inverted rounded-md px-2 py-1 text-sm font-black"
          }
        >
          {GROWTH_STATUS_LABEL[status]}
        </span>
      </header>
      <p>
        Started {longDate(c.startedOn)} ·{" "}
        {c.services.length ? c.services.map(growthServiceLabel).join(", ") : "No services picked"}
      </p>

      {status !== "ended" ? (
        <Confirm summary="Post an update">
          <form action={postGrowthUpdateAction} className="flex flex-col gap-3">
            <input type="hidden" name="clientId" value={c.id} />
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Title</span>
              <input name="title" required maxLength={GROWTH_TITLE_MAX} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">What to tell them</span>
              <textarea
                name="body"
                required
                maxLength={GROWTH_BODY_MAX}
                rows={5}
                className="rounded-lg border border-input bg-paper px-3 py-2 text-base"
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Shows on their dashboard. They get one email saying there&apos;s a new update, with
              the title and a link. Your own words only: nothing from their email.
            </p>
            <Button type="submit" className="w-full">
              Post update
            </Button>
          </form>
        </Confirm>
      ) : null}

      {c.updates.length ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-black">Latest updates</h4>
          <ul className="flex flex-col divide-y rounded-lg border">
            {c.updates.map((u) => (
              <li key={u.id} className="flex flex-col gap-1 px-4 py-2">
                <span className="font-semibold break-words">{u.title}</span>
                <span className="text-sm text-muted-foreground">
                  Posted {relativeTime(u.postedAt, now)} ·{" "}
                  {u.notifiedAt ? "Emailed" : "Not emailed yet"}
                </span>
                {u.notifiedAt ? null : (
                  <form action={emailGrowthUpdateAction}>
                    <input type="hidden" name="updateId" value={u.id} />
                    <Button type="submit" variant="outline" className="w-full">
                      Email it to them
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h4 className="font-black">Monthly numbers</h4>
        {c.months.length === 0 ? (
          <p className="text-muted-foreground">
            None yet. Their dashboard says you add these after the first monthly check-in.
          </p>
        ) : null}
        {c.months.map((m) => (
          <Confirm key={m.month} summary={`${monthLabel(m.month)}: ${monthLine(m)}`}>
            <MonthForm clientId={c.id} month={m.month} values={m} />
          </Confirm>
        ))}
        {newMonths.length ? (
          <Confirm summary="Add numbers for a month">
            <MonthForm clientId={c.id} months={newMonths} />
          </Confirm>
        ) : null}
      </div>

      <Confirm summary="Change services, start date or time zone">
        <form action={changeGrowthAction} className="flex flex-col gap-3">
          <input type="hidden" name="clientId" value={c.id} />
          <ServicesField checked={c.services} />
          <StartField value={c.startedOn} />
          <TimeZoneField value={c.timeZone} />
          <Button type="submit" variant="outline" className="w-full">
            Save services and date
          </Button>
        </form>
      </Confirm>

      {MOVES[status].map((m) => (
        <Confirm key={m.move} summary={m.label}>
          <form action={moveGrowthAction} className="flex flex-col gap-2">
            <input type="hidden" name="clientId" value={c.id} />
            <input type="hidden" name="move" value={m.move} />
            <p>{m.explain}</p>
            <Button type="submit" className="w-full">
              {m.confirm}
            </Button>
          </form>
        </Confirm>
      ))}
    </article>
  );
}

function InviteForm({
  email,
  trade,
  services,
  today,
  from,
}: {
  email?: string;
  trade?: string | null;
  services: readonly GrowthService[];
  today: string;
  from: "growth" | "waitlist";
}) {
  return (
    <form action={inviteToGrowthAction} className="flex flex-col gap-3">
      <input type="hidden" name="from" value={from} />
      {email ? (
        <input type="hidden" name="email" value={email} />
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">Their Gmail address</span>
          <input name="email" type="email" required autoComplete="off" className={field} />
        </label>
      )}
      {trade ? <input type="hidden" name="trade" value={trade} /> : null}
      <ServicesField checked={services} />
      <StartField value={today} />
      <p className="text-sm text-muted-foreground">
        Lets them sign in and see their Growth dashboard, and emails them the sign-in link. It
        doesn&apos;t start an app trial: that only starts if they connect Gmail. Until Google
        approves the app, also add them as a Google test user (the list under Invite an owner).
      </p>
      <Button type="submit" className="w-full">
        Invite to Growth
      </Button>
    </form>
  );
}

export function GrowthClientsSection({
  data,
  choices,
  today,
  now,
  done,
  error,
}: {
  data: Awaited<ReturnType<typeof listGrowthAdmin>>;
  choices: Awaited<ReturnType<typeof growthAccountChoices>>;
  today: string;
  now: Date;
  done?: string;
  error?: string;
}) {
  return (
    <section aria-labelledby="growth-heading" className="flex flex-col gap-3">
      <h2 id="growth-heading" className="text-xl font-black">
        Growth clients ({data.clients.length})
      </h2>
      <p className="text-muted-foreground">
        What you enter here shows on the client&apos;s Growth dashboard. No email content or
        customer names.
      </p>
      {done ? <Notice>{done}</Notice> : null}
      {error ? <Notice strong>{error}</Notice> : null}
      {data.clients.length === 0 ? <p>No Growth clients yet.</p> : null}
      {data.clients.map((c) => (
        <ClientCard key={c.id} c={c} today={today} now={now} />
      ))}

      <Confirm summary="Start Growth for this account">
        {choices.length ? (
          <form action={startGrowthAction} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Account</span>
              <select name="workspaceId" required className={field} defaultValue="">
                <option value="" disabled>
                  Pick an account
                </option>
                {choices.map((a) => (
                  <option key={a.workspaceId} value={a.workspaceId}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <ServicesField checked={[]} />
            <StartField value={today} />
            <TimeZoneField value="America/New_York" />
            <p className="text-sm text-muted-foreground">
              For someone who already has an account. Next time they sign in they can pick the inbox
              or their Growth dashboard. Nothing about their app account changes.
            </p>
            <Button type="submit" className="w-full">
              Start Growth
            </Button>
          </form>
        ) : (
          <p>Every account is already a Growth client.</p>
        )}
      </Confirm>

      <Confirm summary="Invite to Growth (no account yet)">
        <InviteForm services={[]} today={today} from="growth" />
      </Confirm>

      {data.pending.length ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-black">Invited to Growth, not signed in yet</h3>
          <ul className="flex flex-col divide-y rounded-lg border">
            {data.pending.map((p) => (
              <li key={p.email} className="flex flex-col gap-1 px-4 py-2">
                <span className="break-all">{p.email}</span>
                <span className="text-sm text-muted-foreground">
                  Invited {p.invitedAt ? relativeTime(p.invitedAt, now) : ""} ·{" "}
                  {p.startedOn ? `starts ${longDate(p.startedOn)}` : "no start date"} ·{" "}
                  {p.services.map(growthServiceLabel).join(", ") || "no services"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * On a waitlist card with a Growth request: Invite to Growth (a separate, explicit action — a
 * request never invites anyone by itself) and Remove (with a confirmation).
 */
export function WaitlistGrowthControls({
  email,
  trade,
  growthOnly,
  request,
  state,
  hasAccount,
  today,
  now,
}: {
  email: string;
  trade: string | null;
  growthOnly: boolean;
  request: GrowthRequest;
  state: { invitedAt: Date | null; client: GrowthStatus | null } | undefined;
  hasAccount: boolean;
  today: string;
  now: Date;
}) {
  return (
    <div className="flex flex-col gap-2">
      {state?.client ? (
        <span className="font-semibold">Growth client ({GROWTH_STATUS_LABEL[state.client]})</span>
      ) : state?.invitedAt ? (
        <span className="font-semibold">
          Invited to Growth {relativeTime(state.invitedAt, now)}
        </span>
      ) : hasAccount ? (
        <span className="text-sm">
          Has an account: use Start Growth for this account in Growth clients.
        </span>
      ) : (
        <Confirm summary="Invite to Growth">
          <InviteForm
            email={email}
            trade={trade}
            services={GROWTH_SERVICES.filter((s) => request.services.includes(s.label)).map(
              (s) => s.value,
            )}
            today={today}
            from="waitlist"
          />
        </Confirm>
      )}
      <Confirm summary="Remove Growth request">
        <form action={removeGrowthRequestAction} className="flex flex-col gap-2">
          <input type="hidden" name="email" value={email} />
          <p>
            {growthOnly
              ? "Deletes this request and everything they typed in it: name, number, email and note. It can't be undone."
              : "Removes only the Growth call request. Their app waitlist sign-up stays as it is."}
          </p>
          <Button type="submit" className="w-full">
            {growthOnly ? "Yes, delete this request" : "Yes, remove the Growth request"}
          </Button>
        </form>
      </Confirm>
    </div>
  );
}
