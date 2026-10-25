import { gmailThreadLink } from "@/lib/gmail-link";
import { attachmentCardLine, type AttachmentCounts } from "@/server/attachment-rules";

/**
 * Check 40 P2: "3 photos attached · open in Gmail". The files themselves stay in Gmail: we
 * keep only how many came, by kind, so the link is how the owner sees them.
 */
export function AttachmentLine({
  counts,
  gmail,
}: {
  counts: AttachmentCounts | null | undefined;
  gmail: { mailboxEmail: string; gmailThreadId: string } | null;
}) {
  const line = attachmentCardLine(counts);
  if (!line) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-sm">
      <span>{line}</span>
      {gmail ? (
        <>
          <span aria-hidden="true">·</span>
          <a
            href={gmailThreadLink(gmail)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            open in Gmail
          </a>
        </>
      ) : null}
    </p>
  );
}
