import "server-only";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { categoryTag, isCategory } from "@/config/categories";
import { siteConfig } from "@/config/site";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  mailboxes,
  threads,
  users,
  workspaces,
} from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendEmail, type EmailSender } from "@/lib/email";
import { jobsAllowed } from "./lifecycle";

/** The owner's local date and hour, from an IANA time zone. Falls back to Eastern. */
export function localParts(now: Date, timeZone: string): { date: string; hour: number } {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "America/New_York";
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Due once a day, in the owner's chosen hour or any hour after it (so a missed run catches up). */
export function digestDue(
  s: {
    digestEnabled: boolean;
    digestHour: number;
    timeZone: string;
    digestLastSentOn: string | null;
  },
  now: Date,
): { due: boolean; localDate: string } {
  const { date, hour } = localParts(now, s.timeZone);
  return {
    due: s.digestEnabled && hour >= s.digestHour && s.digestLastSentOn !== date,
    localDate: date,
  };
}

export type DigestCounts = {
  repliesReady: number;
  nudgesReady: number;
  needsYou: { category: string | null }[];
  sentYesterday: number;
  sortedYesterday: number;
};

export async function digestCounts(workspaceId: string, now: Date): Promise<DigestCounts> {
  const boxes = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (!boxes.length)
    return { repliesReady: 0, nudgesReady: 0, needsYou: [], sentYesterday: 0, sortedYesterday: 0 };
  const dayAgo = new Date(now.getTime() - 86_400_000);

  const pending = await db()
    .select({ kind: drafts.kind, threadId: drafts.threadId })
    .from(drafts)
    .where(and(inArray(drafts.mailboxId, boxes), eq(drafts.status, "pending")));
  const drafted = new Set(pending.map((p) => p.threadId));
  const needs = (
    await db()
      .select({ id: threads.id, category: threads.category })
      .from(threads)
      .where(
        and(
          inArray(threads.mailboxId, boxes),
          eq(threads.needsOwner, true),
          eq(threads.inInbox, true),
        ),
      )
  ).filter((t) => !drafted.has(t.id));
  const [sent] = await db()
    .select({ n: count() })
    .from(drafts)
    .where(
      and(
        inArray(drafts.mailboxId, boxes),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
        gte(drafts.decidedAt, dayAgo),
      ),
    );
  const [sorted] = await db()
    .select({ n: count() })
    .from(threads)
    .where(and(inArray(threads.mailboxId, boxes), gte(threads.classifiedAt, dayAgo)));

  return {
    repliesReady: pending.filter((p) => p.kind === "reply").length,
    nudgesReady: pending.filter((p) => p.kind === "followup").length,
    needsYou: needs.map((n) => ({ category: n.category })),
    sentYesterday: sent?.n ?? 0,
    sortedYesterday: sorted?.n ?? 0,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The digest itself. Counts and categories only — no customer names, subjects
 * or email text — because this goes through an email provider, and email
 * content only ever goes to the AI provider. The detail is one tap away.
 */
export function buildDigest(c: DigestCounts, queueUrl: string, settingsUrl: string) {
  const byCategory = new Map<string, number>();
  for (const n of c.needsYou) {
    const label =
      n.category && isCategory(n.category) ? categoryTag[n.category].toLowerCase() : "email";
    byCategory.set(label, (byCategory.get(label) ?? 0) + 1);
  }
  const needsLine = c.needsYou.length
    ? `${plural(c.needsYou.length, "email needs", "emails need")} you: ${[...byCategory]
        .map(([label, n]) => (n === 1 ? `a ${label}` : `${n} × ${label}`))
        .join(", ")}.`
    : null;
  const lines = [
    needsLine,
    c.repliesReady
      ? `${plural(c.repliesReady, "reply", "replies")} drafted and waiting for your okay.`
      : null,
    c.nudgesReady
      ? `${plural(c.nudgesReady, "follow-up")} ready for quiet quotes or invoices.`
      : null,
    c.sentYesterday || c.sortedYesterday
      ? `Yesterday: ${plural(c.sortedYesterday, "email")} sorted, ${plural(c.sentYesterday, "reply", "replies")} sent.`
      : null,
  ].filter((l): l is string => !!l);
  const waiting = c.needsYou.length + c.repliesReady + c.nudgesReady;
  const subject = waiting
    ? `${plural(waiting, "thing")} waiting on you`
    : "Nothing waiting on you this morning";

  const text = [
    "Good morning.",
    "",
    ...lines,
    "",
    waiting ? `Open your queue: ${queueUrl}` : "Nothing needs you right now.",
    "",
    `Nothing is sent without your okay. Change or turn off this email: ${settingsUrl}`,
    siteConfig.copyright,
  ].join("\n");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f3;color:#1b1b1b;font-family:Inter,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:24px 16px">
<p style="margin:0;font-family:Georgia,serif;font-style:italic;font-size:24px">good morning,</p>
<p style="margin:0 0 20px;font-weight:900;font-size:30px;letter-spacing:-0.02em">${esc(waiting ? `${plural(waiting, "thing")} waiting.` : "all clear.")}</p>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:17px;line-height:1.45">${esc(l)}</p>`).join("\n")}
${
  waiting
    ? `<p style="margin:24px 0"><a href="${esc(queueUrl)}" style="display:inline-block;background:#1b1b1b;color:#efeeea;text-decoration:none;font-weight:700;font-size:17px;padding:14px 22px;border-radius:10px">Open your queue</a></p>`
    : ""
}
<p style="margin:24px 0 4px;font-size:14px;color:#5e5d59">Nothing is sent without your okay. <a href="${esc(settingsUrl)}" style="color:#5e5d59">Change or turn off this email</a>.</p>
<p style="margin:0;font-size:14px;color:#5e5d59">${esc(siteConfig.copyright)}</p>
</div></body></html>`;

  return { subject, text, html, worthSending: lines.length > 0 };
}

export type DigestRun = { sent: number; skipped: number; notConfigured: boolean };

/**
 * Hourly: send each owner their digest once a day at their hour. Quiet days
 * (nothing waiting, nothing happened) are skipped rather than sending noise.
 */
export async function sendDigests(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<DigestRun> {
  const send = deps.send ?? sendEmail;
  const rows = await db()
    .select({
      workspace: workspaces,
      ownerEmail: users.email,
      profile: {
        digestEnabled: businessProfiles.digestEnabled,
        digestHour: businessProfiles.digestHour,
        timeZone: businessProfiles.timeZone,
        digestLastSentOn: businessProfiles.digestLastSentOn,
      },
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(
      sql`exists (select 1 from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaces.id})`,
    );

  const run: DigestRun = { sent: 0, skipped: 0, notConfigured: false };
  for (const r of rows) {
    if (!jobsAllowed(r.workspace, now)) continue;
    const settings = {
      digestEnabled: r.profile?.digestEnabled ?? true,
      digestHour: r.profile?.digestHour ?? 7,
      timeZone: r.profile?.timeZone ?? "America/New_York",
      digestLastSentOn: r.profile?.digestLastSentOn ?? null,
    };
    const { due, localDate } = digestDue(settings, now);
    if (!due) continue;

    const digest = buildDigest(
      await digestCounts(r.workspace.id, now),
      appUrl("/queue"),
      appUrl("/settings#digest"),
    );
    if (digest.worthSending) {
      const outcome = await send({
        to: r.ownerEmail,
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
        idempotencyKey: `digest-${r.workspace.id}-${localDate}`,
      });
      if (outcome === "not_configured") {
        run.notConfigured = true;
        return run;
      }
      run.sent++;
      await db().insert(activityLog).values({
        workspaceId: r.workspace.id,
        actor: "squared_away",
        action: "digest_sent",
        detail: {},
      });
    } else {
      run.skipped++;
    }
    await db()
      .insert(businessProfiles)
      .values({ workspaceId: r.workspace.id, digestLastSentOn: localDate })
      .onConflictDoUpdate({
        target: businessProfiles.workspaceId,
        set: { digestLastSentOn: localDate },
      });
  }
  return run;
}
