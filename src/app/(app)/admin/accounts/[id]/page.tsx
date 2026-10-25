import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Headline } from "@/components/brand/headline";
import { cn } from "@/lib/utils";
import { supportView } from "@/server/admin";
import { statusLabel, supportSentence } from "@/server/admin-rules";
import { requireAdmin } from "@/server/session";

export const metadata: Metadata = { title: "Account support", robots: { index: false } };

// No loading.tsx here: streaming would turn notFound() (and requireAdmin's 404) into a 200.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check 16 P8: when an owner calls ("I didn't get drafts"), what they see and what happened, from
 * the content-free activity log. No email content and no customer names, ever.
 */
export default async function AccountSupportPage(props: PageProps<"/admin/accounts/[id]">) {
  await requireAdmin();
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const view = await supportView(id, new Date());
  if (!view) notFound();
  const { row, gmail, activity } = view;
  return (
    <>
      <Headline serif="one account," heavy="what happened." />
      <Link
        href={`/admin#acct-${row.workspaceId}`}
        className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
      >
        Back to admin
      </Link>
      <section aria-labelledby="who" className="flex flex-col gap-1">
        <h2 id="who" className="text-xl font-black break-all">
          {row.businessName || row.ownerEmail}
        </h2>
        {row.businessName ? <p className="break-all">{row.ownerEmail}</p> : null}
        <p className="font-semibold">{statusLabel[row.status]}</p>
      </section>

      <section
        aria-labelledby="they-see"
        className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
      >
        <h2 id="they-see" className="text-lg font-black">
          They see
        </h2>
        {gmail.length === 0 ? <p>No Gmail connected yet.</p> : null}
        {gmail.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <p className="font-semibold">{g.label}</p>
            <dl className="flex flex-col gap-1">
              {g.lines.map((l) => (
                <div key={l.label} className="flex flex-col">
                  <dt className="text-sm text-muted-foreground">{l.label}</dt>
                  <dd className={cn(l.problem && "font-black")}>{l.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <section aria-labelledby="happened" className="flex flex-col gap-2">
        <h2 id="happened" className="text-lg font-black">
          What happened
        </h2>
        {activity.length === 0 ? <p>Nothing yet.</p> : null}
        <ol className="flex flex-col divide-y rounded-lg border">
          {activity.map((a, i) => (
            <li key={i} className="px-4 py-2">
              {supportSentence(a)}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
