import type { CSSProperties } from "react";

/**
 * Check 29 P9: a homepage section below the first screen skips style and layout work while it's
 * off screen (`.sa-cv` in theme.css: content-visibility auto), so the Growth switch's theme swap
 * on <html> doesn't restyle the whole ~9,000px page at once. The sizes are the section's measured
 * height on a phone (375px) and from the lg breakpoint up, so the scrollbar barely moves when it
 * renders; `auto` then remembers the real size. Never on the Growth opener (#growth), the sticky
 * header or bar, or anything the switch measures.
 */
export function deferred(phonePx: number, widePx: number) {
  return {
    className: "sa-cv",
    style: { "--sa-cv-m": `${phonePx}px`, "--sa-cv-d": `${widePx}px` } as CSSProperties,
  };
}
