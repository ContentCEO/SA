import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Headline } from "@/components/brand/headline";
import { getBusinessProfile } from "@/server/profile";
import { sendRecord } from "@/server/send-record";
import { requireOwner } from "@/server/session";

// No loading.tsx here on purpose: streaming would turn notFound() into a 200.

/**
 * Plan #41 "See record": the answer to "did the AI send that on its own?".
 * Facts from the activity log only — no email text.
 */
export default async function SendRecordPage(props: PageProps<"/record/[draftId]">) {
  const { workspace } = await requireOwner();
  const { draftId } = await props.params;
  if (!z.string().uuid().safeParse(draftId).success) notFound();
  const r = await sendRecord(workspace.id, draftId);
  if (!r) notFound();

  const timeZone = (await getBusinessProfile(workspace.id))?.timeZone ?? "America/New_York";
  const when = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone,
        }).format(d)
      : "Not recorded";

  const rows: [string, string][] = [
    [
      "Who okayed it",
      r.approvedBy === "autopilot"
        ? "Autopilot — you switched it on for this kind of email"
        : r.approvedBy === "you_in_gmail"
          ? "You, from Gmail"
          : "You",
    ],
    [
      r.approvedBy === "autopilot" ? "Lined up" : "Okayed",
      `${when(r.approvedAt)}${r.device ? ` · on a ${r.device}` : ""}`,
    ],
    ["Sent", when(r.sentAt)],
    ["Changed by you", r.edited ? "Yes — you edited it before it went" : "No — sent as drafted"],
    ["Quick changes", r.changes.length ? r.changes.join(", ") : "None"],
    [
      "Time to stop it",
      r.holdWindowMin
        ? `${r.holdWindowMin} minutes to hold it before it sent`
        : r.undoWindowSec
          ? `${r.undoWindowSec} seconds to undo${r.undone ? ` (you undid it ${r.undone === 1 ? "once" : `${r.undone} times`} first)` : ""}`
          : "Sent the moment you tapped",
    ],
    ["Drafted", when(r.draftedAt)],
    ["Gmail message ID", r.gmailMessageId ?? "Not recorded"],
  ];

  return (
    <>
      <Headline serif="the record," heavy="who okayed it." />
      <dl className="flex flex-col divide-y rounded-xl border bg-card">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 px-4 py-3">
            <dt className="text-sm text-muted-foreground">{k}</dt>
            <dd className="font-semibold break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground">
        Nothing leaves your inbox without your okay — this is the proof for this reply.
      </p>
      <Link href="/activity" className="inline-flex min-h-tap items-center font-semibold underline">
        Back to Activity
      </Link>
    </>
  );
}
