/**
 * Outside text (emails) goes into prompts inside a tagged block. It must not be
 * able to close that block, or open a fake one, and continue as instructions.
 */
export function untrusted(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\s*/?\\s*${tag}\\s*>`, "gi"), (m) => m.replace(/</g, "‹"));
}
