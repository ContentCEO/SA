"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A link in a read-only box with a Copy button. If the phone won't let us copy, the link is
 * selected so the owner can copy it by hand.
 */
export function CopyLink({ url, label }: { url: string; label: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "select">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      input.current?.select();
      setCopied("select");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          ref={input}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-h-tap w-full min-w-0 flex-1 rounded-lg border border-input bg-paper px-3 text-base"
        />
        <Button type="button" variant="outline" onClick={copy}>
          Copy link
        </Button>
      </div>
      <p role="status" className="min-h-6 text-sm">
        {copied === "copied"
          ? "Link copied."
          : copied === "select"
            ? "Couldn't copy here — the link is selected, so copy it by hand."
            : ""}
      </p>
    </div>
  );
}
