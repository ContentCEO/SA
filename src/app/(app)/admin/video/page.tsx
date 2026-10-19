import type { Metadata } from "next";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { Headline } from "@/components/brand/headline";
import { VideoTicks } from "@/components/app/video-ticks";
import { Markdown } from "@/lib/markdown";
import { requireAdmin } from "@/server/session";
import { parseVideoScript, VIDEO_REMINDERS } from "@/server/video-script";

export const metadata: Metadata = { title: "Video script", robots: { index: false } };

// No loading.tsx here: requireAdmin must 404 for everyone else (streaming would make it a 200).

/**
 * Check 28 P7: the demo video script from docs/google-verification.md as a tick list Davi can
 * read on a phone while recording on a computer. Reads only the doc: no thread, message, draft
 * or customer data is selected. Ticks stay on this device (localStorage).
 */
export default async function AdminVideoPage() {
  await requireAdmin();
  const doc = await readFile(path.join(process.cwd(), "docs", "google-verification.md"), "utf8");
  const script = parseVideoScript(doc);

  return (
    <>
      <Headline serif="the demo video," heavy="shot by shot." />
      <Link
        href="/admin"
        className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
      >
        Back to admin
      </Link>
      <p className="text-lg">
        The same script as &ldquo;Demo video script&rdquo; in docs/google-verification.md, one row
        per shot. Tick each one as you film it; the ticks stay on this phone only.
      </p>

      <section
        aria-labelledby="video-reminders"
        className="sa-inverted flex flex-col gap-2 rounded-xl p-5"
      >
        <h2 id="video-reminders" className="text-xl font-black">
          Before you press record
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-lg">
          {VIDEO_REMINDERS.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      {script.intro ? <Markdown source={script.intro} /> : null}

      {script.before.map((b) => (
        <section key={b.title} aria-label={b.title} className="flex flex-col gap-2">
          <h2 className="text-xl font-black">{b.title}</h2>
          {b.intro ? <Markdown source={b.intro} /> : null}
          {b.bullets.length ? (
            <Markdown source={b.bullets.map((x) => `- ${x}`).join("\n")} />
          ) : null}
        </section>
      ))}

      <VideoTicks
        heading={`The ${script.steps.length} shots`}
        rows={script.steps.map((s) => ({
          key: `step-${s.n}`,
          label: `${s.n}. ${s.title}${s.part ? ` (${s.part})` : ""}`,
          children: s.text ? <Markdown source={s.text} /> : undefined,
        }))}
      />
    </>
  );
}
