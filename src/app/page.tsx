import type { Metadata } from "next";
import { ForgetOffline } from "@/components/app/forget-offline";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { QueuePreview } from "@/components/marketing/queue-preview";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { faqs, features, promiseBand, steps } from "@/components/marketing/home-copy";
import { isReferralCode, referralsVisible } from "@/server/referral-rules";
import { SALES_TAX_NOTE } from "@/server/billing-rules";
import { formatDollars, pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import { Phone } from "lucide-react";
import { AboutDavi } from "@/components/marketing/about-davi";
import { GrowthChapter } from "@/components/marketing/growth/growth-chapter";
import { GrowthChapterBar } from "@/components/marketing/growth/growth-chapter-bar";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { GrowthBridge } from "@/components/marketing/growth/growth-bridge";
import { GrowthSwitch } from "@/components/marketing/growth/growth-switch";
import { SiteAnalytics } from "@/components/marketing/site-analytics";
import { StructuredData } from "@/components/marketing/structured-data";
import { phoneHref } from "@/lib/phone-href";

const telHref = phoneHref("tel", siteConfig.phone);

const description =
  "AI email help for contractors, built for carpenters, plumbers, and electricians: Squared Away sorts your business email, drafts replies in your voice, and drafts quote follow-ups — and nothing goes out without your okay.";

export const metadata: Metadata = {
  // The words people search for; the share card keeps the brand line.
  title: "Squared Away — AI email help for contractors",
  description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Squared Away",
    title: "Squared Away — your inbox, handled.",
    description:
      "Built for carpenters, plumbers, and electricians. Sorts your business email, drafts replies in your voice, and waits for your okay before anything goes out.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Squared Away — your inbox, handled.",
    description:
      "Built for carpenters, plumbers, and electricians. Nothing goes out without your okay.",
  },
};

function Section({
  id,
  className,
  children,
  label,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <section id={id} aria-label={label} className={cn("px-4 py-16 sm:py-24", className)}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">{children}</div>
    </section>
  );
}

export default async function HomePage(props: PageProps<"/">) {
  const session = await auth();
  // Signed in: /start (the inbox, or for a Growth client the choice of inbox or Growth).
  if (session?.user?.id) redirect("/start");
  // Plan #47: a referral link's code rides along on the waitlist form — only while it's switched on.
  const { ref } = await props.searchParams;
  const referralCode = referralsVisible() && isReferralCode(ref) ? ref : undefined;
  const plans = Object.values(pricing.plans);

  return (
    <div className="flex flex-1 flex-col">
      <ForgetOffline />
      <header className="sticky top-0 z-10 border-b border-stone/60 bg-paper px-4">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between py-2">
          <Link
            href="/"
            className="inline-flex min-h-tap items-center"
            aria-label="Squared Away home"
          >
            <Wordmark />
          </Link>
          <nav aria-label="Site" className="flex items-center gap-1">
            <Link
              href="#growth"
              className="hidden min-h-tap items-center px-3 font-semibold sm:inline-flex"
            >
              {growthCopy.header.link}
            </Link>
            <Link
              href="#pricing"
              className="hidden min-h-tap items-center px-3 font-semibold sm:inline-flex"
            >
              Pricing
            </Link>
            <Link href="/signin" className="inline-flex min-h-tap items-center px-3 font-semibold">
              Sign in
            </Link>
            <Link
              href="#waitlist"
              className="inline-flex min-h-tap items-center rounded-lg bg-charcoal px-4 font-semibold text-offwhite"
            >
              Get on the list
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex flex-col">
        {/* Part 1, the app (paper). Scrolling past the bridge switches the whole site to Growth. */}
        <div data-sa-half="app">
          <Section label="Introduction" className="pt-10 sm:pt-16">
            <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
              <div className="flex flex-col gap-6">
                <p className="font-semibold text-slate">
                  Built for carpenters, plumbers, and electricians
                </p>
                <Headline serif="your inbox," heavy="handled." size="xl" />
                <p className="max-w-lg text-xl leading-relaxed">
                  Squared Away sorts your business email, drafts replies in your own voice, and
                  chases quiet quotes. <strong>Nothing goes out without your okay.</strong>
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="#waitlist"
                    className="inline-flex min-h-12 items-center justify-center rounded-lg bg-charcoal px-6 text-lg font-semibold text-offwhite"
                  >
                    Join the waitlist
                  </Link>
                  <Link
                    href="#how"
                    className="inline-flex min-h-12 items-center justify-center rounded-lg border-2 border-charcoal px-6 text-lg font-semibold"
                  >
                    How it works
                  </Link>
                </div>
                <p className="text-slate">
                  Works with Gmail · On the web or as an app on your phone · Three-day trial on your
                  real inbox.
                </p>
                <Link
                  href="#growth"
                  className="min-h-tap self-start py-2.5 font-semibold underline underline-offset-4"
                >
                  {/* A plain block (not inline-flex), so a wrapped line keeps the arrow by the last word. */}
                  {growthCopy.hero.link}
                  {"\u00a0"}
                  <span aria-hidden>↓</span>
                </Link>
              </div>
              <QueuePreview />
            </div>
          </Section>

          <Section id="how" label="How it works" className="border-t border-stone">
            <Headline as="h2" serif="three steps," heavy="then back to work." />
            <ol className="grid gap-6 md:grid-cols-3">
              {steps.map((s) => (
                <li key={s.n} className="flex flex-col gap-3 rounded-2xl border bg-card p-6">
                  <span className="sa-headline-heavy text-5xl">{s.n}</span>
                  <h3 className="text-xl font-black">{s.title}</h3>
                  <p className="text-lg leading-relaxed text-slate">{s.body}</p>
                </li>
              ))}
            </ol>
          </Section>

          <section aria-label="Our promise" className="sa-inverted px-4 py-16 sm:py-24">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
              <p className="flex flex-col">
                <span className="sa-headline-serif text-4xl sm:text-5xl">the one rule,</span>{" "}
                <span className="sa-headline-heavy text-5xl sm:text-7xl">your okay first.</span>
              </p>
              <p className="max-w-2xl text-xl leading-relaxed text-ash">{promiseBand.join(" ")}</p>
            </div>
          </section>

          <Section label="What it does">
            <Headline as="h2" serif="what it does," heavy="all day." />
            <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <li key={f.title} className="flex flex-col gap-2 border-t-2 border-charcoal pt-4">
                  <h3 className="text-xl font-black">{f.title}</h3>
                  <p className="text-lg leading-relaxed text-slate">{f.body}</p>
                </li>
              ))}
            </ul>
          </Section>

          <AboutDavi />

          <Section id="pricing" label="Pricing" className="border-t border-stone">
            <Headline as="h2" serif="simple pricing," heavy="no contract." />
            <div className="flex flex-col gap-2 rounded-2xl border-2 border-charcoal p-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-xl font-black">
                  {pricing.setupFee.name} — {formatDollars(pricing.setupFee.amountCents)} once
                </span>
                <span className="text-lg text-slate">
                  A call with us to load your prices, hours, service area and the things you never
                  promise, then tune the drafts until they sound like you.
                </span>
              </div>
            </div>
            <ul className="grid gap-4 md:grid-cols-3">
              {plans.map((p) => (
                <li
                  key={p.name}
                  className={cn(
                    "flex flex-col gap-3 rounded-2xl p-6",
                    p.name === "Crew" ? "sa-inverted" : "border bg-card",
                  )}
                >
                  <span className="text-xl font-black">{p.name}</span>
                  <span>
                    <span className="sa-headline-heavy text-5xl">
                      {formatDollars(p.amountCents)}
                    </span>
                    <span className={p.name === "Crew" ? "text-ash" : "text-slate"}> / month</span>
                  </span>
                  <ul className="flex flex-col gap-1.5 text-lg">
                    <li>
                      {p.mailboxLimit} Gmail inbox{p.mailboxLimit === 1 ? "" : "es"}
                    </li>
                    <li>Sorting, drafts, follow-ups, morning summary</li>
                    {p.autopilot ? <li>Autopilot for the emails you choose</li> : null}
                    {p.name === "Company" ? <li>Priority support</li> : null}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="text-slate">{SALES_TAX_NOTE}</p>
            <p className="text-lg font-semibold">
              On every plan, each reply waits for your okay, and follow-ups are two nudges at most,
              each one a draft you approve. Where autopilot is included, it stays off until you earn
              it, it never answers a complaint or sends a reply that mentions money, and every
              autopilot reply waits 10 minutes so you can stop it.
            </p>
            <p className="text-slate">
              Prices in US dollars. Month to month — stop any time. Every plan starts with the
              three-day trial.
            </p>
            <p className="text-lg">
              Questions about which plan fits?{" "}
              <a
                href={telHref}
                className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              >
                Call {siteConfig.operator} at {siteConfig.phone}
              </a>
            </p>
          </Section>

          <Section label="Questions" className="border-t border-stone">
            <Headline as="h2" serif="good questions," heavy="straight answers." />
            <div className="flex flex-col divide-y divide-stone border-y border-stone">
              {faqs.map((f) => (
                <details key={f.q} className="group py-2">
                  <summary className="flex min-h-tap cursor-pointer list-none items-center justify-between gap-4 text-xl font-black">
                    {f.q}
                    <span
                      aria-hidden
                      className="text-2xl transition-transform group-open:rotate-45 motion-reduce:transition-none"
                    >
                      +
                    </span>
                  </summary>
                  <p className="pb-4 text-lg leading-relaxed text-slate">{f.a}</p>
                </details>
              ))}
            </div>
          </Section>

          <Section id="waitlist" label="Join the waitlist" className="border-t border-stone">
            <div className="grid gap-10 lg:grid-cols-2">
              <div className="flex flex-col gap-4">
                <Headline as="h2" serif="get on the list," heavy="we'll set you up." />
                <p className="text-xl leading-relaxed">
                  We onboard a few shops at a time and set each one up by hand, so it works properly
                  from the first morning.
                </p>
                <div className="flex flex-col gap-2">
                  <p className="text-lg text-slate">Rather talk? Call {siteConfig.operator}.</p>
                  <a
                    href={telHref}
                    className="inline-flex min-h-tap items-center justify-center gap-2 self-start rounded-lg border-2 border-charcoal px-5 text-lg font-semibold"
                  >
                    <Phone aria-hidden className="size-5" />
                    Call {siteConfig.phone}
                  </a>
                </div>
              </div>
              <div className="rounded-2xl border bg-card p-6">
                <WaitlistForm referralCode={referralCode} />
              </div>
            </div>
          </Section>

          <GrowthBridge />
        </div>

        {/* Part 2, one-on-one Growth (charcoal). Its top edge is the switch boundary. */}
        <div className="sa-inverted" data-growth-chapter data-sa-half="growth">
          <GrowthChapterBar />
          <GrowthChapter headingLevel="h2" standalone={false} openerId="growth" />
        </div>
      </main>

      <div className="sa-inverted">
        <div className="mx-auto w-full max-w-5xl px-4 pb-6">
          <SiteFooter growthLink />
        </div>
      </div>

      <GrowthSwitch />
      <StructuredData />
      <SiteAnalytics />
    </div>
  );
}
