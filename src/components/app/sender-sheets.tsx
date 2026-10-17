import { Button } from "@/components/ui/button";
import { CATEGORIES, type Category } from "@/ai/prompts/classify.v4";
import { categoryTag } from "@/config/categories";
import { resortAction, saveSenderRuleAction } from "@/app/(app)/inbox/actions";

/**
 * Ideas H4: "Wrong kind?" — move one conversation to another kind. Fixes this conversation only.
 * Server-rendered; the forms post the thread id and the kind, and the server re-checks both.
 */
export function ResortSheet({
  threadId,
  current,
  hasReply,
  back,
}: {
  threadId: string;
  current: string | null;
  hasReply?: boolean;
  /** Where the toast lands: the screen the sheet is on. */
  back: "inbox" | "queue";
}) {
  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-tap cursor-pointer list-none items-center px-3 font-semibold underline underline-offset-4">
        Wrong kind? Move it
      </summary>
      <form action={resortAction} className="flex flex-col gap-2 px-3 pb-3">
        <input type="hidden" name="threadId" value={threadId} />
        <input type="hidden" name="back" value={back} />
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 font-semibold">What is this email?</legend>
          {CATEGORIES.map((c: Category) => (
            <label key={c} className="flex min-h-tap items-center gap-3">
              <input
                type="radio"
                name="category"
                value={c}
                defaultChecked={c === current}
                className="size-5"
              />
              {categoryTag[c]}
            </label>
          ))}
        </fieldset>
        {hasReply ? (
          <p className="text-sm">Moving it to Junk also throws away the reply we wrote.</p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          This moves this conversation only. Want all their email in Junk? Use Rules for this
          sender.
        </p>
        <Button type="submit" variant="outline" className="w-full">
          Move it
        </Button>
      </form>
    </details>
  );
}

/**
 * Ideas H3: "Rules for this sender". The form posts the email's id (never the address); the
 * server works out the address and checks every guard again.
 */
export function SenderRuleSheet({
  messageId,
  who,
  address,
  company,
  back,
}: {
  messageId: string;
  who: string;
  address: string;
  /** "hillpm.com", or null where a company-wide rule makes no sense (gmail.com, your own). */
  company: string | null;
  back: "inbox" | "queue";
}) {
  return (
    <details className="rounded-lg border">
      <summary className="flex min-h-tap cursor-pointer list-none items-center px-3 font-semibold underline underline-offset-4">
        Rules for this sender
      </summary>
      <form action={saveSenderRuleAction} className="flex flex-col gap-3 px-3 pb-3">
        <input type="hidden" name="messageId" value={messageId} />
        <input type="hidden" name="back" value={back} />
        <p className="font-semibold break-words">Emails from {who}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">What to do</legend>
          <label className="flex min-h-tap items-start gap-3">
            <input type="radio" name="action" value="junk" required className="mt-1 size-5" />
            <span>
              <span className="font-semibold">Always junk</span>
              <span className="block text-sm text-muted-foreground">
                New emails from them usually skip the AI and your queue.
              </span>
            </span>
          </label>
          <label className="flex min-h-tap items-start gap-3">
            <input type="radio" name="action" value="needs_me" className="mt-1 size-5" />
            <span>
              <span className="font-semibold">Always needs me</span>
              <span className="block text-sm text-muted-foreground">
                They go to the top, marked Needs you. We wait for you before writing a reply.
              </span>
            </span>
          </label>
          <label className="flex min-h-tap items-start gap-3">
            <input type="radio" name="action" value="no_draft" className="mt-1 size-5" />
            <span>
              <span className="font-semibold">Never draft</span>
              <span className="block text-sm text-muted-foreground">
                They&apos;re sorted as usual, but we never write a reply or a follow-up unless you
                tap Draft a reply.
              </span>
            </span>
          </label>
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 font-semibold">Apply to</legend>
          <label className="flex min-h-tap items-center gap-3 break-all">
            <input
              type="radio"
              name="scope"
              value="address"
              defaultChecked
              className="size-5 shrink-0"
            />
            Just {address}
          </label>
          {company ? (
            <label className="flex min-h-tap items-center gap-3 break-all">
              <input type="radio" name="scope" value="domain" className="size-5 shrink-0" />
              Anyone at {company}
            </label>
          ) : null}
        </fieldset>
        <p className="text-sm text-muted-foreground">
          Always needs me for just this address adds them to your VIPs.
        </p>
        <Button type="submit" variant="outline" className="w-full">
          Save rule
        </Button>
      </form>
    </details>
  );
}
