import { Phone } from "lucide-react";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { siteConfig } from "@/config/site";
import { phoneHref } from "@/lib/phone-href";
import { cn } from "@/lib/utils";
import { GrowthCallForm } from "./growth-call-form";
import { growthCopy as c } from "./growth-copy";

function Section({
  id,
  label,
  className,
  children,
}: {
  id?: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className={cn("border-t border-ash/40 px-4 py-16 sm:py-24", className)}
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
}: {
  headingLevel: "h1" | "h2";
  standalone: boolean;
  openerId?: string;
}) {
  return (
    <>
      <section
        id={openerId}
        aria-label={c.opener.region}
        className={cn("px-4 py-16 sm:py-24", openerId && "scroll-mt-18")}
      >
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

      <Section label={c.services.region}>
        <Headline as="h2" serif={c.services.serif} heavy={c.services.heavy} />
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.services.items.map((s) => (
            <li key={s.title} className="rounded-2xl border border-ash/40 p-6">
              <h3 className="text-xl font-black">{s.title}</h3>
              <p className="mt-2 text-lg text-ash">{s.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section label={c.how.region}>
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

      <Section label={c.rules.region}>
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
          <Headline as="h2" serif={c.who.serif} heavy={c.who.heavy} />
          <p className="max-w-2xl text-xl leading-relaxed">{c.who.body}</p>
        </Section>
      ) : null}

      <Section label={c.faq.region}>
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

      <Section id="growth-call" label={c.call.region} className="scroll-mt-18">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <Headline as="h2" serif={c.call.serif} heavy={c.call.heavy} />
            <p className="text-xl leading-relaxed">{c.call.body}</p>
            <p className="text-lg text-ash">{c.call.talkNow}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <a href={phoneHref("tel", siteConfig.phone)} className={outlined}>
                {c.call.callLink}
              </a>
              <a href={phoneHref("sms", siteConfig.phone)} className={outlined}>
                {c.call.textLink}
              </a>
            </div>
          </div>
          <div className="sa-light rounded-2xl p-5 sm:p-6">
            <GrowthCallForm />
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
