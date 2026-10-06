import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { QueuePreview } from "@/components/marketing/queue-preview";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { formatDollars, pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Squared Away — your inbox, handled.",
  description:
    "For carpenters, plumbers and electricians: Squared Away sorts your business email, drafts replies in your voice, and chases quiet quotes — and nothing goes out without your okay.",
  openGraph: {
    title: "Squared Away — your inbox, handled.",
    description:
      "Sorts your business email, drafts replies in your voice, and waits for your okay before anything goes out.",
  },
};

const steps = [
  {
    n: "1",
    title: "Connect your Gmail",
    body: "We show you exactly what Squared Away can and can't do before Google asks for permission. Takes two minutes.",
  },
  {
    n: "2",
    title: "It sorts and drafts",
    body: "Every email is sorted — quote, question, scheduling, invoice, complaint, junk — and replies are written in your own words, as real Gmail drafts.",
  },
  {
    n: "3",
    title: "You tap Send reply",
    body: "Read it, change it if you like, send it. From the truck, between jobs, one-handed.",
  },
];

const features = [
  {
    title: "Sorts every email",
    body: "Quote requests, questions, scheduling, invoices, suppliers. Complaints and anything big are put in front of you, not answered.",
  },
  {
    title: "Writes like you",
    body: "It learns your greetings, sign-off and phrases from your sent mail. It never invents a price, a date or a promise — it asks, or flags it for you.",
  },
  {
    title: "Chases quiet quotes",
    body: "If a customer goes quiet on a quote or invoice, it drafts a friendly nudge. Two at most, ever — never pushy.",
  },
  {
    title: "Morning summary",
    body: "One short email at the time you choose: what's waiting and what needs you. Skipped on quiet mornings.",
  },
  {
    title: "Autopilot, when you're ready",
    body: "Off by default. Earned one kind of email at a time, never for complaints or money, and every reply waits 10 minutes so you can stop it.",
  },
  {
    title: "Your data stays yours",
    body: "Email text is deleted after 30 days. It's only used to write your replies — never to train AI. Disconnect any time.",
  },
];

const faqs = [
  {
    q: "Will it send emails without me?",
    a: "No. Every reply waits in your queue until you tap Send reply. Autopilot exists, but it's off until you switch it on for a specific kind of email, and only after you've approved ten of those yourself.",
  },
  {
    q: "Do I have to change how I do email?",
    a: "No. It works inside the Gmail you already use. Drafts appear in your Gmail Drafts folder too, so you can send from either place.",
  },
  {
    q: "Can it see all my email?",
    a: "It reads the last 30 days of your business email to sort it, and your recent sent mail to learn how you write. It can't delete, archive or move anything — it doesn't have permission to.",
  },
  {
    q: "What does the trial look like?",
    a: "Three days with your real inbox. It sorts and drafts so you can judge the replies — nothing can send during the trial. If it's not for you, disconnect and you're done.",
  },
  {
    q: "What if I stop?",
    a: "Disconnect Gmail in Settings and our access is removed at Google straight away. Want it all gone? Delete my account in Settings erases everything we hold, in one tap. Month to month, no contract.",
  },
];

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

export default async function HomePage() {
  const session = await auth();
  if (session?.user?.id) redirect("/queue");
  const plans = Object.values(pricing.plans);

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-stone/60 bg-paper/90 px-4 backdrop-blur">
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
        <Section label="Introduction" className="pt-10 sm:pt-16">
          <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
            <div className="flex flex-col gap-6">
              <p className="font-semibold text-slate">For carpenters, plumbers and electricians</p>
              <Headline serif="your inbox," heavy="handled." size="xl" />
              <p className="max-w-lg text-xl leading-relaxed">
                Squared Away sorts your business email, drafts replies in your own voice, and chases
                quiet quotes. <strong>Nothing goes out without your okay.</strong>
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
              <span className="sa-headline-serif text-4xl sm:text-5xl">the one rule,</span>
              <span className="sa-headline-heavy text-5xl sm:text-7xl">your okay first.</span>
            </p>
            <p className="max-w-2xl text-xl leading-relaxed text-ash">
              Squared Away drafts; you decide. Replies sit in your queue until you tap Send reply —
              and during your three-day trial, sending is switched off entirely, in the code, not
              just hidden behind a button.
            </p>
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
                  <span className="sa-headline-heavy text-5xl">{formatDollars(p.amountCents)}</span>
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
          <p className="text-slate">
            Prices in US dollars. Month to month — stop any time. Every plan starts with the
            three-day trial.
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
              <p className="text-lg text-slate">
                Rather talk? Call {siteConfig.operator} at{" "}
                <a
                  href={`tel:${siteConfig.phone}`}
                  className="font-semibold text-charcoal underline underline-offset-4"
                >
                  {siteConfig.phone}
                </a>
                .
              </p>
            </div>
            <div className="rounded-2xl border bg-card p-6">
              <WaitlistForm />
            </div>
          </div>
        </Section>
      </main>

      <div className="mx-auto w-full max-w-5xl px-4 pb-6">
        <SiteFooter />
      </div>
    </div>
  );
}
