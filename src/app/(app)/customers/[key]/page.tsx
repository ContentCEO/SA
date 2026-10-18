import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Headline } from "@/components/brand/headline";
import { categoryTag, isCategory } from "@/config/categories";
import { gmailThreadLink } from "@/lib/gmail-link";
import { headlineName } from "@/lib/headline-name";
import { relativeTime } from "@/lib/relative-time";
import { customerByKey } from "@/server/customers";
import { customerFactsLine } from "@/server/customer-rules";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";
import { isReadOnly } from "@/server/lifecycle";
import { NOTE_MAX_CHARS, NOTE_REFUSALS, noteFor } from "@/server/customer-notes";
import { removeNoteAction, saveNoteAction } from "../actions";

const NOTE_DONE: Record<string, string> = {
  note_saved: "Note saved.",
  note_removed: "Note removed.",
};
const NOTE_ERRORS: Record<string, string> = {
  ...NOTE_REFUSALS,
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  unknown: "That didn't work. Refresh and try again.",
};

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage(props: PageProps<"/customers/[key]">) {
  const { workspace } = await requireOwner();
  const { key } = await props.params;
  const now = new Date();
  const customer = await customerByKey(workspace.id, key, now);
  if (!customer) notFound();
  const profile = await getBusinessProfile(workspace.id);
  const facts = customerFactsLine(customer, profile?.timeZone ?? "America/New_York");
  // Check 13 P7: titles, "Last, First", companies and missing names all read right.
  const first = headlineName(customer.name, customer.address);
  const note = await noteFor(workspace.id, customer.address);
  const params = await props.searchParams;
  const doneMsg = typeof params.done === "string" ? NOTE_DONE[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? NOTE_ERRORS[params.error] : undefined;
  const readOnly = isReadOnly(workspace);

  return (
    <>
      {/* Check 7 P11: the same back link as the Settings screens (an icon, not a typed arrow). */}
      <Link
        href="/customers"
        className="-ml-1 inline-flex min-h-tap items-center gap-1 self-start font-semibold underline-offset-4 hover:underline"
      >
        <ChevronLeft aria-hidden className="size-5" />
        All customers
      </Link>
      <Headline serif={`${first},`} heavy="every email." />
      <div className="flex flex-col gap-1">
        <p className="text-xl font-black">{customer.name ?? customer.address}</p>
        <a
          href={`mailto:${customer.address}`}
          className="inline-flex min-h-tap items-center font-semibold break-all underline underline-offset-4"
        >
          {customer.address}
        </a>
        {facts ? <p className="font-semibold">{facts}</p> : null}
      </div>
      {customer.addresses.length ? (
        <section aria-labelledby="job-addresses" className="flex flex-col gap-1">
          <h2 id="job-addresses" className="font-semibold">
            Job addresses
          </h2>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {customer.addresses.map((a) => (
              <li key={a} className="break-words">
                {a}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section
        id="note"
        aria-labelledby="note-heading"
        className="flex scroll-mt-4 flex-col gap-3 rounded-xl border bg-card p-4"
      >
        <h2 id="note-heading" className="text-xl font-black">
          Your private note
        </h2>
        <p className="text-muted-foreground">
          Only you see this. It&apos;s never sent to customers or to the AI.
        </p>
        {doneMsg ? <Notice>{doneMsg}</Notice> : null}
        {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}
        {readOnly ? (
          note ? (
            <p className="break-words">{note}</p>
          ) : null
        ) : (
          <form action={saveNoteAction} className="flex flex-col gap-3">
            <input type="hidden" name="key" value={key} />
            <label className="flex flex-col gap-1.5">
              <span className="font-semibold">Note</span>
              <textarea
                name="note"
                rows={3}
                maxLength={NOTE_MAX_CHARS}
                defaultValue={note ?? ""}
                placeholder="Gate code, dog, best time to call…"
                className="w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base"
              />
              <span className="text-sm text-muted-foreground">
                Up to {NOTE_MAX_CHARS} characters.
              </span>
            </label>
            <Button type="submit" className="w-full">
              Save note
            </Button>
          </form>
        )}
        {note && !readOnly ? (
          <details>
            <summary className="inline-flex min-h-tap cursor-pointer items-center font-semibold underline underline-offset-4">
              Remove note
            </summary>
            <form action={removeNoteAction} className="flex flex-col gap-2 pt-2">
              <input type="hidden" name="key" value={key} />
              <p>Remove this note?</p>
              <Button type="submit" variant="outline" className="w-full">
                Remove note
              </Button>
            </form>
          </details>
        ) : null}
      </section>
      <ul className="flex flex-col gap-3">
        {customer.threads.map((t) => (
          <li key={t.threadId} className="flex flex-col gap-1 rounded-xl border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold">
                {t.category && isCategory(t.category) ? categoryTag[t.category] : "Email"}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {t.lastMessageAt ? relativeTime(t.lastMessageAt, now) : ""}
              </span>
            </div>
            {t.stage ? <p className="font-semibold">{t.stage}</p> : null}
            <p>{t.summary ?? t.subject ?? "(no subject)"}</p>
            <a
              href={gmailThreadLink(t)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              Open in Gmail
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
