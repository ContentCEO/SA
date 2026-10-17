import type { Metadata } from "next";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { adminToday } from "@/server/growth-client-rules";
import { growthAccountChoices, listGrowthAdmin } from "@/server/growth-clients";
import { requireAdmin } from "@/server/session";
import { GROWTH_DONE, GROWTH_ERRORS, GrowthClientsSection } from "../growth-admin";

export const metadata: Metadata = { title: "Growth clients", robots: { index: false } };

/**
 * Davi's Squared Away Growth clients (2026-10-16), on their own page so /admin stays light:
 * start, change, pause or end Growth, post updates, enter monthly numbers, invite. Only what
 * Davi entered; Growth never uses inbox data. Like every admin page: 404 for anyone else.
 */
export default async function AdminGrowthPage(props: PageProps<"/admin/growth">) {
  await requireAdmin();
  const params = await props.searchParams;
  const now = new Date();
  const [data, choices] = await Promise.all([listGrowthAdmin(), growthAccountChoices()]);
  const done = typeof params.done === "string" ? GROWTH_DONE[params.done] : undefined;
  const error = typeof params.error === "string" ? GROWTH_ERRORS[params.error] : undefined;
  return (
    <>
      <Headline serif="squared away growth," heavy="your clients." />
      <Link
        href="/admin"
        className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
      >
        Back to admin
      </Link>
      <GrowthClientsSection
        data={data}
        choices={choices}
        today={adminToday(now)}
        now={now}
        done={done}
        error={error}
      />
    </>
  );
}
