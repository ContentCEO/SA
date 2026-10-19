import Image from "next/image";
import { Headline } from "@/components/brand/headline";
import { liveProof, type GrowthProofItem } from "@/config/growth-proof";
import { growthCopy as c } from "./growth-copy";

/**
 * Check 2 P6: "what it looks like, for real." Renders nothing at all (no heading) until
 * src/config/growth-proof.ts holds an item with a client's written okay, checked in the last 12
 * months. /growth is static, so `now` is the build time: a rebuild hides items that went stale.
 */
export function GrowthProof({ items, now }: { items: readonly GrowthProofItem[]; now: Date }) {
  const live = liveProof(items, now);
  if (live.length === 0) return null;
  return (
    <section aria-label={c.proof.region} className="border-t border-ash/40 px-4 py-16 sm:py-24">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">
        <Headline as="h2" serif={c.proof.serif} heavy={c.proof.heavy} />
        <ul className="grid gap-6 sm:grid-cols-2">
          {live.map((p) => (
            <li
              key={`${p.shop}-${p.checkedOn}-${p.kind}`}
              className="flex flex-col gap-3 rounded-2xl border border-ash/40 p-6"
            >
              {p.kind === "before_after" && p.images?.length ? (
                <div className="grid grid-cols-2 gap-2">
                  {p.images.slice(0, 2).map((src, i) => (
                    <Image
                      key={src}
                      src={src}
                      alt={c.proof.imageAlt(p.shop, i === 0 ? "before" : "after")}
                      width={480}
                      height={360}
                      className="aspect-[4/3] w-full rounded-lg object-cover"
                    />
                  ))}
                </div>
              ) : null}
              {p.text ? <p className="text-lg">{p.text}</p> : null}
              <p className="font-black">{c.proof.byline(p.shop, p.town)}</p>
              {p.kind === "link" && p.href?.startsWith("https://") ? (
                <a
                  href={p.href}
                  className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
                >
                  {c.proof.link(p.shop)}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
