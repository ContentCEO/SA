"use client";

import { Sun } from "lucide-react";
import { useState } from "react";
import { contrastCookie } from "@/lib/device-cookies";
import { cn } from "@/lib/utils";

/**
 * Plan #37 Sunlight: easier to read outdoors, remembered on this device. Check 8 P4: the tap
 * changes the screen itself — it flips data-contrast on the app wrapper (#sa-app) and writes the
 * cookie from the page — so it's instant and works with no signal. No server call, no refresh;
 * the server reads the same cookie so the next page load starts in the right look.
 */
export function SunlightButton({ initial }: { initial: boolean }) {
  // Null until tapped: follows the server's value (e.g. after a refresh), then the tap's.
  const [tapped, setTapped] = useState<boolean | null>(null);
  const on = tapped ?? initial;

  const toggle = () => {
    const next = !on;
    const app = document.getElementById("sa-app");
    if (next) app?.setAttribute("data-contrast", "high");
    else app?.removeAttribute("data-contrast");
    document.cookie = contrastCookie(next, location.protocol === "https:");
    setTapped(next);
  };

  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={toggle}
      className={cn(
        "inline-flex min-h-tap min-w-tap items-center justify-center gap-1.5 rounded-md px-2 font-semibold",
        on && "sa-inverted font-black",
      )}
    >
      <Sun aria-hidden className="size-5" strokeWidth={on ? 2.75 : 2} />
      {/* Words on phones (room to spare); icon only beside the full nav. */}
      <span className="sm:sr-only">Sunlight</span>
    </button>
  );
}
