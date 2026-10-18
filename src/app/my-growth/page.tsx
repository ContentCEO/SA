import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter } from "@/components/app/site-footer";
import { Headline } from "@/components/brand/headline";
import { Wordmark } from "@/components/brand/wordmark";
import { portalCopy } from "@/components/growth-portal/portal-copy";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { buttonVariants } from "@/components/ui/button";
import { growthServiceLabel } from "@/config/growth";
import { siteConfig } from "@/config/site";
import { phoneHref } from "@/lib/phone-href";
import { cn } from "@/lib/utils";
import {
  EMPTY_CHECK_IN,
  EMPTY_CHECK_IN_MONTH,
  longDate,
  type Metric,
} from "@/server/growth-client-rules";
import { growthDashboard, portalClient } from "@/server/growth-clients";
import { requireOwner } from "@/server/session";

export const metadata: Metadata = { title: portalCopy.dashboard.title, robots: { index: false } };

const c = portalCopy.dashboard;

function MetricBlock({ m, strong = false }: { m: Metric; strong?: boolean }) {
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-xl p-4",
        strong ? "sa-inverted" : "border bg-card",
      )}
    >
      <h3 className="text-lg font-black">{m.label}</h3>
      <p className="text-3xl font-black">{m.value}</p>
      <p className={strong ? undefined : "text-muted-foreground"}>{m.source}</p>
    </li>
  );
}

function Period({
  region,
  serif,
  heavy,
  metrics,
  checkIns,
  empty,
}: {
  region: string;
  serif: string;
  heavy: string;
  metrics: Metric[];
  checkIns: number;
  empty: string;
}) {
  return (
    <section aria-label={region} className="flex flex-col gap-4">
      <Headline as="h2" size="md" serif={serif} heavy={heavy} />
      {metrics.length ? (
        <ul className="flex flex-col gap-3">
          {metrics.map((m) => (
            <MetricBlock key={m.key} m={m} strong={m.key === "money"} />
          ))}
        </ul>
      ) : null}
      {checkIns === 0 ? <p className="text-lg">{empty}</p> : null}
    </section>
  );
}

/**
 * A Squared Away Growth client's dashboard (Davi, 2026-10-16): what Davi entered after each
 * monthly check-in (Growth never uses inbox data), the updates feed, their services with the
 * pledge, and a way to call or text Davi. Signed in, the
 * current terms, and an active or paused Growth client — anyone else gets a 404 (so no
 * loading.tsx here: streaming would turn notFound into a 200). Only this workspace's rows.
 */
export default async function MyGrowthPage() {
  const { workspace } = await requireOwner();
  const client = await portalClient(workspace.id);
  if (!client) notFound();
  const d = await growthDashboard(client);
  const postedOn = new Intl.DateTimeFormat("en-US", {
    timeZone: d.timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const start = longDate(d.startedOn);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-4 pt-6 pb-10">
      <header className="flex items-center justify-between gap-3">
        <Link href="/start" className="inline-flex min-h-tap items-center rounded-md">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="flex items-center">
          <Link
            href="/queue"
            className="inline-flex min-h-tap items-center px-2 font-semibold underline underline-offset-4"
          >
            {c.inboxLink}
          </Link>
        </nav>
      </header>
      <main className="flex flex-1 flex-col gap-10">
        <div className="flex flex-col gap-3">
          <p className="font-semibold text-muted-foreground">{c.eyebrow}</p>
          <Headline serif={c.serif} heavy={c.heavy} />
          {d.status === "paused" ? (
            <p role="status" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
              {c.paused}
            </p>
          ) : null}
          {!d.started ? <p className="text-lg">{c.notStarted(start)}</p> : null}
        </div>

        {d.started ? (
          <>
            <Period
              region={c.since.region}
              serif={c.since.serif}
              heavy={c.since.heavy(start)}
              metrics={d.since.metrics}
              checkIns={d.since.checkIns}
              empty={EMPTY_CHECK_IN}
            />
            <Period
              region={c.month.region}
              serif={c.month.serif}
              heavy={c.month.heavy(d.monthName)}
              metrics={d.thisMonth.metrics}
              checkIns={d.thisMonth.checkIns}
              empty={d.since.checkIns === 0 ? EMPTY_CHECK_IN : EMPTY_CHECK_IN_MONTH}
            />
          </>
        ) : null}

        <section aria-label={c.updates.region} className="flex flex-col gap-4">
          <Headline as="h2" size="md" serif={c.updates.serif} heavy={c.updates.heavy} />
          {d.updates.length === 0 ? <p className="text-lg">{c.updates.empty}</p> : null}
          {d.updates.length ? (
            <ol className="flex flex-col gap-3">
              {d.updates.map((u) => (
                <li key={u.id}>
                  <article className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                    <h3 className="text-lg font-black break-words">{u.title}</h3>
                    <p className="text-sm text-muted-foreground">
                      <time dateTime={u.postedAt.toISOString()}>{postedOn.format(u.postedAt)}</time>
                    </p>
                    <p className="text-lg break-words whitespace-pre-line">{u.body}</p>
                  </article>
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        <section aria-label={c.services.region} className="flex flex-col gap-4">
          <Headline as="h2" size="md" serif={c.services.serif} heavy={c.services.heavy} />
          {d.services.length ? (
            <ul className="flex flex-wrap gap-2">
              {d.services.map((s) => (
                <li
                  key={s}
                  className="rounded-lg border-2 border-charcoal px-3 py-1.5 font-semibold"
                >
                  {growthServiceLabel(s)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-lg">{c.services.none}</p>
          )}
          <div className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4">
            <p className="text-xl font-black">{growthCopy.pledge.heavy}</p>
            <p className="text-lg">{growthCopy.pledge.body}</p>
            <p className="text-lg font-semibold">{growthCopy.pledge.percent}</p>
          </div>
        </section>

        {siteConfig.phone ? (
          <section aria-label={c.talk.region} className="flex flex-col gap-4">
            <Headline as="h2" size="md" serif={c.talk.serif} heavy={c.talk.heavy} />
            <div className="flex flex-col gap-3 sm:flex-row">
              <a
                href={phoneHref("tel", siteConfig.phone)}
                className={buttonVariants({ size: "lg", className: "w-full sm:w-auto" })}
              >
                {c.talk.call}
              </a>
              <a
                href={phoneHref("sms", siteConfig.phone)}
                className={buttonVariants({
                  size: "lg",
                  variant: "outline",
                  className: "w-full sm:w-auto",
                })}
              >
                {c.talk.text}
              </a>
            </div>
          </section>
        ) : null}

        <Link
          href="/settings/account"
          className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
        >
          {c.account}
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}
