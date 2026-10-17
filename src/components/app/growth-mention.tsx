import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { growthCopy } from "@/components/marketing/growth/growth-copy";

const c = growthCopy.appMention;

/**
 * The only way the signed-in app may mention Squared Away Growth (CLAUDE.md "Growth cross-sell
 * rule"; Davi, 2026-10-16): static text, the same for every owner. It takes NO props on purpose,
 * so nothing from the owner's mail, drafts, quotes, money or activity can decide whether or what
 * it shows; tests/unit/growth-boundary.test.ts checks that. Placed on the More screen only, and
 * hidden there for read-only or expired accounts. Never on /billing, or in any email, alert or
 * text.
 */
export function GrowthMention() {
  return (
    <aside aria-label={c.label} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <p className="text-lg font-semibold">{c.label}</p>
      <p className="text-muted-foreground">{c.line}</p>
      <Link
        href="/growth"
        className="inline-flex min-h-tap items-center gap-1 self-start font-semibold underline underline-offset-4"
      >
        {c.link} <ChevronRight aria-hidden className="size-4" />
      </Link>
    </aside>
  );
}
