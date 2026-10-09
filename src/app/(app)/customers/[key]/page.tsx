import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Headline } from "@/components/brand/headline";
import { categoryTag, isCategory } from "@/config/categories";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { customerByKey } from "@/server/customers";
import { requireOwner } from "@/server/session";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage(props: PageProps<"/customers/[key]">) {
  const { workspace } = await requireOwner();
  const { key } = await props.params;
  const customer = await customerByKey(workspace.id, key);
  if (!customer) notFound();
  const now = new Date();
  const first = (customer.name ?? customer.address).split(/[\s,]+/)[0]!.toLowerCase();

  return (
    <>
      <Link href="/customers" className="inline-flex min-h-tap items-center font-semibold">
        ← All customers
      </Link>
      <Headline serif={`${first},`} heavy="every email." />
      <div className="flex flex-col gap-1">
        <p className="text-xl font-black">{customer.name ?? customer.address}</p>
        <a
          href={`mailto:${customer.address}`}
          className="inline-flex min-h-tap items-center font-semibold break-all underline underline-offset-4"
        >
          {customer.address}
        </a>
      </div>
      <ul className="flex flex-col gap-3">
        {customer.threads.map((t) => (
          <li key={t.threadId} className="flex flex-col gap-1 rounded-xl border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold">
                {t.category && isCategory(t.category) ? categoryTag[t.category] : "Email"}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {t.lastMessageAt ? relativeTime(t.lastMessageAt, now) : ""}
              </span>
            </div>
            <p>{t.summary ?? t.subject ?? "(no subject)"}</p>
            <a
              href={gmailThreadLink(t)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              Open in Gmail
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
