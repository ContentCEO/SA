/**
 * Check 24 P2: only the owner's own words from a sent email, for voice learning. Pure.
 *
 * Cuts at the start of anything someone else wrote (reply headers in English, Spanish,
 * Portuguese and French, wrapped Gmail headers, Outlook's From/Sent/To/Subject block and its
 * underscore rule, Gmail and Apple Mail forwards, "Original Message"), drops ">" lines, phone
 * footers ("Sent from my iPhone"), an RFC "-- " signature and a trailing signature block with
 * a phone, a link or a license number. Classification keeps its own `prepareBody`.
 */

export type OwnWords = {
  text: string;
  /** The cut was at a forwarded message (so a near-empty own part is just a forward). */
  forward: boolean;
};

const REPLY_HEADER = /^(On|El|Em|Le)\s.+(wrote|escribió|escreveu|a écrit)\s*:?\s*$/i;
const WRAPPED_END = /(wrote|escribió|escreveu|a écrit)\s*:\s*$/i;
const FORWARD_MARKERS = [/^Begin forwarded message:?\s*$/i, /^-{5,}\s*Forwarded message\s*-{5,}/i];
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}/i;
const UNDERSCORE_RULE = /^_{10,}\s*$/;
/** A header names someone (an email address) or a moment (a year or a clock time). */
const HEADER_FACTS = /[\w.+-]+@[\w-]+\.[\w.-]+|\b(19|20)\d{2}\b|\b\d{1,2}:\d{2}\b/;

const FOOTERS = [
  /^Sent from my (iPhone|iPad|Galaxy|Samsung|Android|mobile)\b.*$/i,
  /^Get Outlook for (iOS|Android)\b.*$/i,
  /^Sent from Yahoo Mail\b.*$/i,
  /^Sent from Mail for Windows\b.*$/i,
  /^Sent from (Outlook|my Verizon|my T-Mobile)\b.*$/i,
];

const SIGNATURE_FACT =
  /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|https?:\/\/|www\.|\bLic\b|\bLicen[sc]e\b|\bHIC\b|\bCSL\b|#/i;
const SHORT_LINE = 60;

const nextNonBlank = (lines: string[], from: number) => {
  for (let i = from; i < lines.length; i++) if (lines[i]!.trim()) return i;
  return -1;
};

/** Where the owner's own part ends, and whether that's a forward. */
function findCut(lines: string[]): { at: number; forward: boolean } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (FORWARD_MARKERS.some((re) => re.test(line))) return { at: i, forward: true };
    if (ORIGINAL_MESSAGE.test(line) || UNDERSCORE_RULE.test(line)) {
      return { at: i, forward: outlookSubjectIsForward(lines, i) };
    }
    if (/^From:\s*\S/i.test(line)) {
      const window = lines.slice(i + 1, i + 5).map((l) => l.trim());
      if (window.some((l) => /^(Sent|Date):/i.test(l)) && window.some((l) => /^Subject:/i.test(l)))
        return { at: i, forward: outlookSubjectIsForward(lines, i) };
    }
    if (/^(On|El|Em|Le)\s/i.test(line)) {
      // One line ("On Tue, … wrote:", "El mar, … escribió:") or wrapped over up to 3 lines.
      let end = -1;
      if (REPLY_HEADER.test(line)) end = i;
      else
        for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++)
          if (WRAPPED_END.test(lines[j]!.trim())) {
            end = j;
            break;
          }
      if (end < 0) continue;
      const header = lines.slice(i, end + 1).join(" ");
      const after = nextNonBlank(lines, end + 1);
      // "On Friday the inspector wrote:" in the owner's own text isn't a header: only cut when
      // quoted text follows, the email ends, or the header names an address or a date.
      if (after < 0 || lines[after]!.trim().startsWith(">") || HEADER_FACTS.test(header))
        return { at: i, forward: false };
    }
  }
  return null;
}

function outlookSubjectIsForward(lines: string[], from: number): boolean {
  return lines
    .slice(from, from + 8)
    .some((l) => /^Subject:\s*(Fw|Fwd|RV|TR|ENC)\s*:/i.test(l.trim()));
}

const contactLine = (line: string) =>
  SIGNATURE_FACT.test(line) &&
  wordCount(
    line
      .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
      .replace(/[\d().#+-]+/g, " ")
      .replace(/\b(Lic|License|Licence|HIC|CSL|No|Tel|Cell|Office|Phone|Mobile|Fax)\b\.?:?/gi, " "),
  ) <= 4;

/**
 * Drop a trailing signature: in the last block of 2+ short lines, everything from the first
 * line that is mostly a phone, a link or a license number. The sign-off above it stays.
 */
function dropSignatureBlock(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim() && lines[start - 1]!.trim().length <= SHORT_LINE)
    start--;
  if (end - start < 2) return lines.slice(0, end);
  const first = lines.slice(start, end).findIndex(contactLine);
  return first < 0 ? lines.slice(0, end) : lines.slice(0, start + first);
}

export function splitOwnWords(body: string): OwnWords {
  let lines = body.replace(/\r\n?/g, "\n").split("\n");
  const cut = findCut(lines);
  if (cut) lines = lines.slice(0, cut.at);
  // RFC 3676 signature separator.
  const sig = lines.findIndex((l) => /^--\s?$/.test(l));
  if (sig >= 0) lines = lines.slice(0, sig);
  lines = lines.filter(
    (l) => !l.trimStart().startsWith(">") && !FOOTERS.some((re) => re.test(l.trim())),
  );
  lines = dropSignatureBlock(lines);
  const text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, forward: cut?.forward ?? false };
}

export function ownWords(body: string): string {
  return splitOwnWords(body).text;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
