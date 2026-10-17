import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { growthCopy } from "@/components/marketing/growth/growth-copy";

const c = growthCopy.inApp;

/**
 * The one mention of Squared Away Growth inside the app (Davi, 2026-10-16), on the More screen
 * only. No props on purpose: the same static words for every owner, never tied to anything
 * the inbox app holds (Growth never uses inbox data). Never on /billing, read-only or expired
 * screens, or in any email, alert or text.
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
