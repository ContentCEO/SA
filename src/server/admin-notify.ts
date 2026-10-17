import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender } from "@/lib/email";

/**
 * Content-free emails to Davi (ADMIN_EMAIL) that go out at most once per `key`: a model that's
 * missing (Check 48 P3), background jobs that look stopped, an account at 80% of its daily AI
 * limit (Check 1 P4). Counts, model names and links only — never an owner's address, a business
 * name or anything from anyone's email.
 *
 * The `app_settings` marker `admin_notice:<key>` is written only after Resend took the email (or
 * our own record says an earlier try did), so a refused or unconfigured send is tried again next
 * time. The same key is Resend's idempotency key, so two runs racing send it once.
 */
export type AdminNotice = {
  subject: string;
  serif: string;
  heavy: string;
  lines: readonly string[];
  /** An /admin path for the button. */
  path?: string;
  footer?: string;
};

export type AdminNoticeResult = "sent" | "already" | "not_configured" | "no_admin";

export const ADMIN_NOTICE_PREFIX = "admin_notice:";

export async function notifyAdminOnce(
  key: string,
  notice: AdminNotice,
  deps: { send?: EmailSender; now?: Date } = {},
): Promise<AdminNoticeResult> {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return "no_admin";
  const marker = `${ADMIN_NOTICE_PREFIX}${key}`;
  const [seen] = await db().select().from(appSettings).where(eq(appSettings.key, marker));
  if (seen) return "already";
  const { text, html } = brandEmail({
    serif: notice.serif,
    heavy: notice.heavy,
    lines: [...notice.lines],
    button: { label: "Open admin", url: appUrl(notice.path ?? "/admin") },
    footer: notice.footer ?? "Squared Away sends this on its own. Nothing from anyone's email.",
  });
  const outcome = await (deps.send ?? sendEmail)({
    to,
    subject: notice.subject,
    text,
    html,
    idempotencyKey: `admin-${key}`.replace(/[^A-Za-z0-9_-]/g, "-"),
  });
  if (outcome === "not_configured") return "not_configured";
  await db()
    .insert(appSettings)
    .values({ key: marker, value: (deps.now ?? new Date()).toISOString() })
    .onConflictDoNothing();
  return "sent";
}

/** Notice markers are only needed for a couple of days (their keys carry a day or an hour). */
export async function purgeAdminNoticeMarkers(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  await db()
    .delete(appSettings)
    .where(
      and(
        sql`(${appSettings.key} like 'admin_notice:%' or ${appSettings.key} like 'model_down:%')`,
        sql`${appSettings.value} < ${cutoff}`,
      ),
    );
}

/** Rejects with a TimeoutError after `ms`, so a slow email service never holds anything up. */
export async function withTimeoutMs<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error("Timed out.");
          err.name = "TimeoutError";
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
