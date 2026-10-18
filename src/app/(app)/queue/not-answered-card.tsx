import { ContactButtons } from "@/components/app/contact-buttons";
import { categoryTag, isCategory } from "@/config/categories";
import { gmailThreadLink } from "@/lib/gmail-link";
import type { LeadCard } from "@/server/lead-cards";
import type { NotAnsweredRow } from "@/server/never-answered";
import { waitingWords } from "@/server/never-answered-rules";
import { draftReplyAction } from "./actions";
import { DraftReplyButton } from "./draft-reply-button";
import { CalledThem } from "./called-them";

/** Leads package (B6): one "Not answered yet" row. Light card: it waits, it isn't urgent. */
export function NotAnsweredCard({
  row,
  lead,
  now,
  readOnly,
}: {
  row: NotAnsweredRow;
  lead: LeadCard | undefined;
  now: Date;
  readOnly: boolean;
}) {
  const noun = isCategory(row.category) ? categoryTag[row.category] : "Email";
  return (
    <article className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-lg font-black">
          {row.customerName || row.customerAddress || "Unknown sender"}
        </span>
        <span className="shrink-0 text-sm font-semibold">
          {waitingWords(row.waitingSince, now)}
        </span>
      </div>
      <span className="text-sm font-semibold">{noun}</span>
      {lead?.repeat ? <p className="text-sm font-semibold">{lead.repeat}</p> : null}
      {row.summary ? <p className="text-muted-foreground">{row.summary}</p> : null}
      <div className="grid grid-cols-1 gap-2 pt-1">
        {readOnly ? null : (
          <form action={draftReplyAction} className="flex flex-col gap-1">
            <input type="hidden" name="threadId" value={row.threadId} />
            <DraftReplyButton />
          </form>
        )}
        {lead?.phone && lead.phoneShown ? (
          <ContactButtons
            phone={lead.phone}
            phoneShown={lead.phoneShown}
            firstName={lead.firstName}
            textBody={lead.textBody}
          />
        ) : null}
        {readOnly ? null : (
          <CalledThem
            threadId={row.threadId}
            hasDraft={false}
            label="Done — I answered"
            confirm="Yes, done"
          />
        )}
        <a
          href={gmailThreadLink(row)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-tap items-center justify-center font-semibold underline underline-offset-4"
        >
          Open in Gmail
        </a>
      </div>
    </article>
  );
}
