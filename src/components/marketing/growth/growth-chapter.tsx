import { Phone } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { GROWTH_PROOF } from "@/config/growth-proof";
import { siteConfig } from "@/config/site";
import { phoneHref } from "@/lib/phone-href";
import { deferred } from "@/lib/deferred-section";
import { cn } from "@/lib/utils";
import { GrowthCallForm } from "./growth-call-form";
import { growthCopy as c } from "./growth-copy";
import { GrowthProof } from "./growth-proof";

function Section({
  id,
  label,
  className,
  children,
  defer,
}: {
  id?: string;
  label: string;
  className?: string;
  children: React.ReactNode;
  /** Check 29 P9: [phone px, wide px] for an off-screen section (src/lib/deferred-section.ts). */
  defer?: [number, number];
}) {
  const d = defer ? deferred(...defer) : null;
  return (
    <section
      id={id}
      aria-label={label}
      className={cn("border-t border-ash/40 px-4 py-16 sm:py-24", d?.className, className)}
      style={d?.style}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">{children}</div>
    </section>
  );
}

const outlined =
  "inline-flex min-h-tap items-center justify-center rounded-lg border-2 border-offwhite px-5 font-semibold";

/**
 * Squared Away Growth, on charcoal: the homepage's second part (h2, after the scroll switch in
 * growth-switch.tsx; `openerId="growth"` puts the `#growth` anchor on the opener) and the whole
 * of /growth (h1, standalone, with "who does the work" and a way back to the app).
 * The opener headline carries `sa-land`: on the homepage it lands as the switch's bands fly out.
 * Every string is in growth-copy.ts.
 */
export function GrowthChapter({
  headingLevel,
  standalone,
  openerId,
  referrals,
}: {
  headingLevel: "h1" | "h2";
  standalone: boolean;
  openerId?: string;
  /** Plan #47: referral links are on, so the form reads a link's ?ref= (the homepage). */
  referrals?: boolean;
}) {
  return (
    <>
      <section id={openerId} aria-label={c.opener.region} className="px-4 py-16 sm:py-24">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <p className="font-semibold text-ash">{c.opener.eyebrow}</p>
          <Headline
            as={headingLevel}
            size="xl"
            serif={c.opener.serif}
            heavy={c.opener.heavy}
            className="sa-land"
          />
          <p className="max-w-2xl text-xl leading-relaxed">{c.opener.body}</p>
          {standalone ? null : (
            <p className="max-w-2xl text-xl leading-relaxed">{c.opener.homeOnly}</p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="#growth-call"
              className="inline-flex min-h-12 items-center justify-center rounded-lg bg-offwhite px-6 text-lg font-semibold text-charcoal"
            >
              {c.opener.button}
            </Link>
            <a
              href={phoneHref("tel", siteConfig.phone)}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border-2 border-offwhite px-6 font-semibold"
            >
              <Phone aria-hidden className="size-5" />
              {c.opener.call}
            </a>
          </div>
          {standalone ? null : (
            <Link
              href="/growth"
              className="inline-flex min-h-tap items-center gap-1 self-start font-semibold underline underline-offset-4"
            >
              {c.opener.pageLink} <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      </section>

      <Section label={c.services.region} defer={[2643, 1201]}>
        <Headline as="h2" serif={c.services.serif} heavy={c.services.heavy} />
        {/* Check 2 P9: the first card spans two columns, so seven cards leave no lone card
            (sm: 2 + 2×3; lg: 2+1+1, then 4). One column on phones. */}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {c.services.items.map((s, i) => (
            <li
              key={s.title}
              className={cn("rounded-2xl border border-ash/40 p-6", i === 0 && "sm:col-span-2")}
            >
              <h3 className="text-xl font-black">{s.title}</h3>
              <p className="mt-2 text-lg text-ash">{s.body}</p>
              <ul
                aria-label={c.services.includesLabel(s.title)}
                className="mt-3 flex flex-col gap-1"
              >
                {s.includes.map((line) => (
                  <li key={line} className="flex items-baseline gap-2 text-lg text-ash">
                    <span aria-hidden className="size-2 shrink-0 translate-y-[-0.15em] bg-ash" />
                    {line}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section label={c.pledge.region} defer={[512, 451]}>
        <Headline as="h2" serif={c.pledge.serif} heavy={c.pledge.heavy} />
        <div className="flex max-w-3xl flex-col gap-4 border-l-4 border-offwhite pl-5">
          <p className="text-xl leading-relaxed">{c.pledge.body}</p>
          <p className="text-xl font-black">{c.pledge.percent}</p>
        </div>
      </Section>

      <Section label={c.how.region} defer={[873, 521]}>
        <Headline as="h2" serif={c.how.serif} heavy={c.how.heavy} />
        <ol className="grid gap-6 md:grid-cols-3">
          {c.how.steps.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3">
              <span aria-hidden className="sa-headline-heavy text-5xl">
                {i + 1}
              </span>
              <h3 className="text-xl font-black">{s.title}</h3>
              <p className="text-lg text-ash">{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section label={c.rules.region} defer={[949, 617]}>
        <Headline as="h2" serif={c.rules.serif} heavy={c.rules.heavy} />
        <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {c.rules.items.map((r) => (
            <li key={r.title} className="flex flex-col gap-2 border-t-2 border-offwhite pt-4">
              <h3 className="text-xl font-black">{r.title}</h3>
              <p className="text-lg text-ash">{r.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      {standalone ? (
        <Section label={c.who.region}>
          {/* Check 2 P6: the operator's photo from siteConfig; null = text only, as before. */}
          {siteConfig.operatorPhoto ? (
            <Image
              src={siteConfig.operatorPhoto.src}
              alt={siteConfig.operatorPhoto.alt}
              width={448}
              height={448}
              className="aspect-square w-full max-w-48 rounded-2xl object-cover"
            />
          ) : null}
          <Headline as="h2" serif={c.who.serif} heavy={c.who.heavy} />
          <p className="max-w-2xl text-xl leading-relaxed">{c.who.body}</p>
        </Section>
      ) : null}

      <GrowthProof items={GROWTH_PROOF} now={new Date()} />

      <Section label={c.faq.region} defer={[814, 830]}>
        <Headline as="h2" serif={c.faq.serif} heavy={c.faq.heavy} />
        <div className="divide-y divide-ash/40 border-y border-ash/40">
          {c.faq.items.map((f) => (
            <details key={f.q} className="group">
              <summary className="flex min-h-tap cursor-pointer list-none items-center justify-between gap-4 py-4 text-lg font-semibold">
                {f.q}
                <span
                  aria-hidden
                  className="text-2xl transition-transform group-open:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </summary>
              <p className="pb-5 text-lg text-ash">
                {typeof f.a === "string" ? (
                  f.a
                ) : (
                  <>
                    {f.a.before}
                    <Link
                      href="/privacy"
                      className="inline-flex min-h-tap items-center underline underline-offset-4"
                    >
                      {f.a.link}
                    </Link>
                    {f.a.after}
                  </>
                )}
              </p>
            </details>
          ))}
        </div>
      </Section>

      <Section id="growth-call" label={c.call.region}>
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Headline as="h2" serif={c.call.serif} heavy={c.call.heavy} />
            <p className="text-xl leading-relaxed">{c.call.body}</p>
            <p className="text-lg text-ash">{c.call.talkNow}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <a href={phoneHref("tel", siteConfig.phone)} className={outlined}>
                {c.call.callLink}
              </a>
              {/* Check 2 P9: an sms: link usually does nothing on a desktop. */}
              <a href={phoneHref("sms", siteConfig.phone)} className={cn(outlined, "lg:hidden")}>
                {c.call.textLink}
              </a>
            </div>
          </div>
          <div className="sa-light rounded-2xl p-5 sm:p-6">
            <GrowthCallForm referrals={referrals} />
          </div>
        </div>
      </Section>

      {standalone ? (
        <Section label={c.closing.region}>
          <p className="max-w-2xl text-xl leading-relaxed">{c.closing.body}</p>
          <Link
            href="/"
            className="inline-flex min-h-tap items-center gap-1 self-start font-semibold underline underline-offset-4"
          >
            {c.closing.link} <span aria-hidden>→</span>
          </Link>
        </Section>
      ) : null}
    </>
  );
}
