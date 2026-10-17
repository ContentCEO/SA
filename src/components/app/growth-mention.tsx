import Link from "next/link";
import { growthCopy } from "@/components/marketing/growth/growth-copy";

/**
 * The only way the signed-in app may mention Squared Away Growth (CLAUDE.md "Growth cross-sell
 * rule"): static text, the same for every owner. It takes NO props on purpose, so nothing from
 * the owner's mail, drafts, quotes, money or activity can decide whether or what it shows.
 * tests/unit/growth-boundary.test.ts checks that. Not placed on any screen yet: where it appears
 * is Davi's call (never on /billing, read-only or expired screens).
 */
export function GrowthMention() {
  return (
    <p className="text-ash">
      {growthCopy.appMention.line}{" "}
      <Link
        href="/growth"
        className="inline-flex min-h-tap items-center underline underline-offset-4"
      >
        {growthCopy.appMention.link}
      </Link>
    </p>
  );
}
