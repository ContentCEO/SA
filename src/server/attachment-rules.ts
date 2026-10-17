/**
 * Check 40 P2: what came attached to an email, in plain words, from counts by kind only (no
 * file name or content is ever stored). Pure: shared by the cards and, once the Prompt
 * versions group adds it, the sorter's and drafter's "Attached: …" line.
 */
export type AttachmentCounts = { images: number; pdfs: number; other: number };

const NONE: AttachmentCounts = { images: 0, pdfs: 0, other: 0 };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 photos, 1 PDF, 2 files" — or null when nothing came attached. */
export function attachmentWords(c: AttachmentCounts | null | undefined): string | null {
  const { images, pdfs, other } = c ?? NONE;
  const parts = [
    images ? plural(images, "photo", "photos") : null,
    pdfs ? plural(pdfs, "PDF", "PDFs") : null,
    other ? plural(other, "file", "files") : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(", ") : null;
}

/** The card line: "3 photos attached" (the card adds "· open in Gmail" as a link). */
export function attachmentCardLine(c: AttachmentCounts | null | undefined): string | null {
  const words = attachmentWords(c);
  return words ? `${words} attached` : null;
}

/** Sums the counts of several emails (a conversation's customer emails). */
export function sumAttachments(rows: AttachmentCounts[]): AttachmentCounts {
  return rows.reduce(
    (a, r) => ({ images: a.images + r.images, pdfs: a.pdfs + r.pdfs, other: a.other + r.other }),
    { ...NONE },
  );
}
