import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown renderer for our own documents (privacy
 * policy, terms) — headings, paragraphs, lists, tables, block quotes, bold,
 * italic, code and links. It builds React elements, never raw HTML, so even
 * a stray tag in a document can't inject markup. Not for user input.
 */

const INLINE = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={k}>{inline(part.slice(2, -2), k)}</strong>;
    if (part.length > 2 && part.startsWith("_") && part.endsWith("_"))
      return <em key={k}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={k} className="rounded bg-offwhite px-1 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      const href = link[2]!;
      // Check 27 P2: the Contact block's "Text:" link is an sms: link.
      const safe = /^(https:|mailto:|tel:|sms:|\/)/.test(href) ? href : "#";
      const external = safe.startsWith("https:");
      return (
        <a
          key={k}
          href={safe}
          className="font-semibold underline underline-offset-4"
          {...(external ? { rel: "noreferrer", target: "_blank" } : {})}
        >
          {link[1]}
        </a>
      );
    }
    return <Fragment key={k}>{part}</Fragment>;
  });
}

/**
 * Paragraph text: lines joined with spaces; a line ending in "\" is a hard break. Check 7 P1:
 * the lines of each segment are joined first and `inline()` runs on the whole segment, so a
 * bold phrase (or a link) that Prettier wrapped across two source lines still matches, instead
 * of showing its ** stars.
 */
function paragraph(lines: string[], key: string): ReactNode[] {
  const segments: string[][] = [[]];
  lines.forEach((line, i) => {
    const hard = line.endsWith("\\");
    segments[segments.length - 1]!.push(hard ? line.slice(0, -1) : line);
    if (hard && i < lines.length - 1) segments.push([]);
  });
  const out: ReactNode[] = [];
  segments.forEach((segment, s) => {
    if (s > 0) out.push(<br key={`${key}-br-${s}`} />);
    out.push(...inline(segment.join(" "), `${key}-${s}`));
  });
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({
  source,
  skipFirstH1 = false,
}: {
  source: string;
  /** Check 7 P8: the page shows its own headline, so the document's "# Title" line isn't repeated. */
  skipFirstH1?: boolean;
}) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let skippedH1 = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      if (level === 1 && skipFirstH1 && !skippedH1) {
        skippedH1 = true;
        i++;
        continue;
      }
      const text = inline(heading[2]!, key);
      blocks.push(
        level === 1 ? (
          <h1 key={key} className="sa-headline-heavy text-4xl sm:text-5xl">
            {text}
          </h1>
        ) : level === 2 ? (
          <h2 key={key} className="pt-4 text-2xl font-black">
            {text}
          </h2>
        ) : (
          <h3 key={key} className="text-xl font-black">
            {text}
          </h3>
        ),
      );
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">"))
        quote.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(
        <div key={key} role="note" className="sa-inverted rounded-xl p-4 text-lg">
          {paragraph(quote, key)}
        </div>,
      );
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      blocks.push(
        // Focusable with a name, so the sideways scroll works from a keyboard too (round 2, TC:
        // axe's scrollable-region-focusable).
        <div
          key={key}
          role="region"
          aria-label="Table, scrolls sideways"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c} scope="col" className="border-b bg-offwhite p-3 font-black">
                    {inline(h, `${key}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className="border-b p-3 align-top">
                      {inline(c, `${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[][] = [];
      while (i < lines.length && (/^\s*-\s+/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!))) {
        const l = lines[i++]!;
        if (/^\s*-\s+/.test(l)) items.push([l.replace(/^\s*-\s+/, "")]);
        else items[items.length - 1]!.push(l.trim());
      }
      blocks.push(
        <ul key={key} className="flex list-disc flex-col gap-2 pl-6">
          {items.map((it, n) => (
            <li key={n}>{paragraph(it, `${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|>|\s*-\s+|\|)/.test(lines[i]!))
      para.push(lines[i++]!.trim());
    blocks.push(<p key={key}>{paragraph(para, key)}</p>);
  }
  return <div className="flex flex-col gap-4 text-lg leading-relaxed">{blocks}</div>;
}
