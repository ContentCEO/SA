import Link from "next/link";

/**
 * Ideas G7: the owner's private note about this customer, on their cards and rows. Visible
 * text only (never an aria-label). The Edit link carries an email id, never an address.
 */
export function NoteLine({
  note,
  editKey,
  hidden,
}: {
  note: string | null | undefined;
  editKey: string | null | undefined;
  /** This phone keeps a copy of the queue (offline okays): say a note exists, never its text. */
  hidden?: boolean;
}) {
  if (!note) return null;
  const href = editKey ? `/customers/${editKey}#note` : null;
  return (
    <p className="text-sm">
      <span className="font-semibold">{hidden ? "Note saved" : "Note:"}</span>{" "}
      {hidden ? null : <span className="line-clamp-2 inline break-words">{note}</span>}
      {href ? (
        <>
          {" "}
          <Link
            href={href}
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            {hidden ? "Open" : "Edit"}
          </Link>
        </>
      ) : null}
    </p>
  );
}
