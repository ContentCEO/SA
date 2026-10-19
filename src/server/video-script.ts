/**
 * Check 28 P7: the demo video script in docs/google-verification.md, parsed for the /admin/video
 * tick-box page, so Davi can read it on a phone while recording on a computer. Pure (text in,
 * structure out; no `server-only`, no database); the page reads the file. A unit test keeps the
 * step count in step with the doc, so a renumbered script can't silently drop a shot.
 */

export type BeforeList = {
  /** The bold lead-in, e.g. "Before recording: fill the demo Gmail". */
  title: string;
  /** The rest of that paragraph (Markdown), may be empty. */
  intro: string;
  /** Bullet items (Markdown), may be empty. */
  bullets: string[];
};

export type ScriptStep = {
  n: number;
  /** The bold title, e.g. "Sign in." */
  title: string;
  /** The step's text after the title (Markdown). */
  text: string;
  /** The Part heading the step sits under, e.g. "Part 1 — a business that can send". */
  part: string;
};

export type VideoScript = {
  /** The section's opening paragraph (Markdown). */
  intro: string;
  before: BeforeList[];
  steps: ScriptStep[];
};

const SECTION = "\n## Demo video script\n";
const MAPPING = "### Which test checks each step";

/** The "Demo video script" section up to its mapping table, as lines. */
function scriptLines(doc: string): string[] {
  const start = doc.indexOf(SECTION);
  if (start < 0) throw new Error("docs/google-verification.md has no Demo video script section.");
  const rest = doc.slice(start + SECTION.length);
  const end = rest.indexOf(MAPPING);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\r\n/g, "\n").split("\n");
}

const BOLD_LEAD = /^\*\*([^*]+)\*\*\s*(.*)$/;
const STEP = /^(\d+)\.\s+\*\*([^*]+)\*\*\s*(.*)$/;

export function parseVideoScript(doc: string): VideoScript {
  const lines = scriptLines(doc);
  const out: VideoScript = { intro: "", before: [], steps: [] };
  let part = "";
  let i = 0;
  const blank = (l: string | undefined) => l === undefined || !l.trim();

  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const step = line.match(STEP);
    if (step) {
      const text: string[] = [step[3]!.trim()];
      i++;
      // Continuation lines are indented and don't start the next step.
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !STEP.test(lines[i]!.trim())) {
        text.push(lines[i++]!.trim());
      }
      out.steps.push({
        n: Number(step[1]),
        title: step[2]!.trim(),
        text: text.filter(Boolean).join(" "),
        part,
      });
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      // A bullet list belongs to the before-block just above it.
      const items: string[][] = [];
      while (i < lines.length && (/^\s*-\s+/.test(lines[i]!) || /^\s{2,}\S/.test(lines[i]!))) {
        const l = lines[i++]!;
        if (/^\s*-\s+/.test(l)) items.push([l.replace(/^\s*-\s+/, "").trim()]);
        else items[items.length - 1]!.push(l.trim());
      }
      const target = out.before[out.before.length - 1];
      if (target) target.bullets.push(...items.map((it) => it.join(" ")));
      continue;
    }
    // A paragraph.
    const para: string[] = [];
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !/^\s*-\s+/.test(lines[i]!) &&
      !STEP.test(lines[i]!)
    ) {
      para.push(lines[i++]!.trim());
    }
    const text = para.join(" ");
    const lead = text.match(BOLD_LEAD);
    if (lead && /^Part\s/.test(lead[1]!)) {
      part = lead[1]!.trim();
    } else if (lead && /^Before recording/.test(lead[1]!)) {
      out.before.push({ title: lead[1]!.trim(), intro: lead[2]!.trim(), bullets: [] });
    } else if (!out.intro) {
      out.intro = text;
    }
  }
  return out;
}

/** Fixed reminders shown above the steps, whatever the doc says (Check 28 P7). */
export const VIDEO_REMINDERS = [
  "Film in a normal desktop browser tab, not the installed app: the installed app hides the address bar, and the client_id has to show there.",
  "Use only the demo Gmail with invented emails. Never a mailbox with real customers in it.",
  "Upload the finished video to YouTube as Unlisted, and paste only its link into Google's form.",
] as const;
