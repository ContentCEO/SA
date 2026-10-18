import type { ReactNode } from "react";
import { ContactButtons } from "@/components/app/contact-buttons";
import { PendingButton } from "@/components/app/pending-button";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/relative-time";
import type { QueueItem } from "@/server/drafts";
import { playbookApplies } from "@/server/complaint-rules";
import type { LeadCard } from "@/server/lead-cards";
import { draftReplyAction } from "./actions";
import { CalledThem } from "./called-them";
import { injectionClearable } from "@/server/injection-clear-rules";
import {
  addTownAction,
  clearInjectionAction,
  closeCheckinAction,
  markFixedAction,
} from "./leads-actions";
import { RemindMe, type SnoozeOption } from "./remind-me";

const linkClass =
  "inline-flex min-h-tap items-center justify-center font-semibold underline underline-offset-4";

/**
 * One "Needs you" card (lifted out of the queue page for the leads package). What the owner
 * can do depends on what the email is: an emergency (Call now first), a voicemail or text
 * message (Call back, no draft), a lead website's notice (Open <site>, no draft), a complaint
 * (Call first, Mark fixed), a fixed complaint's check-in, or an ordinary email. Nothing here
 * sends anything: Call / Text are the owner's own phone, drafts wait in the queue.
 */
export function NeedsYouCard({
  i,
  lead,
  who,
  tag,
  readOnly,
  remindOptions,
  gmailHref,
  timeZone,
  note,
  resort,
  nextThreadId,
  notice,
}: {
  i: QueueItem;
  lead: LeadCard | undefined;
  who: string;
  tag: string;
  readOnly: boolean;
  remindOptions: SnoozeOption[];
  gmailHref: string;
  timeZone: string;
  /** Ideas G7: the owner's private note line (hidden on a phone that keeps an offline copy). */
  note?: ReactNode;
  /** Ideas H4: the "Move it" sheet (never on a read-only account or a check-in). */
  resort?: ReactNode;
  /** Check 9 P5: the card after this one, where a snooze or "I called them" lands. */
  nextThreadId?: string | null;
  /** Check 9 P5: the done / error notice for a tap on this card. */
  notice?: ReactNode;
}) {
  const channel = lead?.channel ?? null;
  const phoneLine = channel?.kind === "phone" || channel?.kind === "phone_text";
  const site = channel?.kind === "site" ? channel : null;
  const complaint = !i.checkIn && playbookApplies(i);
  const name = phoneLine
    ? (lead?.firstName ?? (channel?.kind === "phone" ? "Voicemail" : "Text message"))
    : site
      ? (lead?.site?.customerName ?? `${site.name} lead`)
      : who;
  const label = i.checkIn
    ? `Check in · ${tag}`
    : i.lane
      ? `Emergency · ${tag}`
      : phoneLine
        ? `${channel?.kind === "phone" ? "Voicemail" : "Text message"} · ${tag}`
        : site
          ? `${site.name} lead · ${tag}`
          : tag;
  const siteLine = [lead?.site?.service, lead?.site?.town].filter(Boolean).join(" · ");
  const fixedDay = i.complaintFixedAt
    ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(i.complaintFixedAt)
    : null;
  const contact =
    lead?.phone && lead.phoneShown ? (
      <ContactButtons
        phone={lead.phone}
        phoneShown={lead.phoneShown}
        firstName={lead.firstName}
        textBody={lead.textBody}
        inverted
        callFirst={i.lane || phoneLine || complaint}
        callLabel={
          phoneLine
            ? "Call back"
            : complaint
              ? `Call ${lead.firstName ?? "them"} first`
              : i.lane
                ? `Call ${lead.firstName ?? "them"} now`
                : undefined
        }
      />
    ) : null;
  // No email answers a lead website or a phone message: no Draft a reply there.
  const canDraft = !readOnly && !phoneLine && !site && !i.checkIn;

  return (
    <article
      id={`t-${i.threadId}`}
      className="sa-inverted flex scroll-mt-4 scroll-mb-28 flex-col gap-2 rounded-xl p-4 sm:scroll-mb-4"
    >
      {notice}
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-lg font-black">{name}</span>
        <span className="shrink-0 text-sm text-ash">
          {i.lastMessageAt ? relativeTime(i.lastMessageAt) : ""}
        </span>
      </div>
      <span className="text-sm font-semibold">
        {i.backFromSnooze ? "Back from snooze · " : ""}
        {label}
      </span>
      {note}
      {i.checkIn ? (
        <p className="font-semibold">
          You marked this fixed{fixedDay ? ` on ${fixedDay}` : ""}. Check they&apos;re happy?
        </p>
      ) : i.needsOwnerReason ? (
        <p className="font-semibold">{i.needsOwnerReason}</p>
      ) : null}
      {siteLine ? <p className="font-semibold">{siteLine}</p> : null}
      {lead?.repeat ? <p className="text-sm font-semibold">{lead.repeat}</p> : null}
      {lead?.outsideTown && !i.checkIn ? (
        <p className="font-black">{lead.outsideTown} isn&apos;t one of your towns.</p>
      ) : null}
      {i.summary ? <p className="text-ash">{i.summary}</p> : null}
      {site ? (
        <p className="text-sm">
          Answer them on {site.name} — replies by email don&apos;t reach them.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-2 pt-1">
        {site?.openUrl ? (
          <a
            href={site.openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-tap items-center justify-center rounded-lg bg-paper px-4 font-black text-charcoal"
          >
            Open {site.name}
          </a>
        ) : null}
        {contact}
        {canDraft ? (
          <form action={draftReplyAction}>
            <input type="hidden" name="threadId" value={i.threadId} />
            <Button type="submit" className="w-full">
              {lead?.outsideTown ? "Draft a reply anyway" : "Draft a reply"}
            </Button>
          </form>
        ) : null}
        {!readOnly && lead?.outsideTown && !i.checkIn ? (
          <form action={addTownAction}>
            <input type="hidden" name="threadId" value={i.threadId} />
            <PendingButton pending="Adding…" className="w-full">
              Add {lead.outsideTown} to my towns
            </PendingButton>
          </form>
        ) : null}
        {!readOnly && i.checkIn ? (
          <form action={closeCheckinAction}>
            <input type="hidden" name="threadId" value={i.threadId} />
            <PendingButton pending="Saving…" className="w-full">
              All good
            </PendingButton>
          </form>
        ) : null}
        {!readOnly && !i.checkIn && injectionClearable(i.extracted) ? (
          <form action={clearInjectionAction}>
            <input type="hidden" name="threadId" value={i.threadId} />
            <PendingButton pending="Saving…" className="w-full">
              This is a normal email
            </PendingButton>
          </form>
        ) : null}
        {!readOnly && complaint ? (
          <form action={markFixedAction}>
            <input type="hidden" name="threadId" value={i.threadId} />
            <PendingButton pending="Saving…" className="w-full">
              Mark fixed
            </PendingButton>
          </form>
        ) : null}
        <RemindMe
          threadId={i.threadId}
          nextThreadId={nextThreadId}
          options={remindOptions}
          inverted
        />
        {readOnly || i.checkIn || complaint ? null : phoneLine ? (
          <CalledThem
            threadId={i.threadId}
            nextThreadId={nextThreadId}
            hasDraft={false}
            inverted
            label="Done — I called back"
            confirm="Yes, done"
          />
        ) : site || i.lane ? (
          <CalledThem
            threadId={i.threadId}
            nextThreadId={nextThreadId}
            hasDraft={false}
            inverted
            label="Done — I answered"
            confirm="Yes, done"
          />
        ) : (
          <CalledThem threadId={i.threadId} nextThreadId={nextThreadId} hasDraft={false} inverted />
        )}
        {readOnly || i.checkIn ? null : resort}
        <a href={gmailHref} target="_blank" rel="noreferrer" className={linkClass}>
          {channel?.kind === "phone" ? "Open in Gmail (to play it)" : "Open in Gmail"}
        </a>
      </div>
    </article>
  );
}
