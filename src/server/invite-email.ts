import "server-only";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { siteConfig } from "@/config/site";
import { db } from "@/db";
import { appSettings, invites } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender, emailErrorFields } from "@/lib/email";
import { normalizeEmail } from "./accounts";
import { inviteEmailCopy } from "./first-week-rules";

/** Salted like the other email keys, so a marker can't be matched against a list of addresses. */
function inviteKey(email: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "")
    .update(normalizeEmail(email))
    .digest("hex")
    .slice(0, 16);
}

export type InviteEmailOutcome = "sent" | "already_sent" | "not_configured" | "skipped" | "failed";

/**
 * Round 2 (FW A1): "you're in" with the sign-in link, once per invite (the same invite never
 * gets two; a fresh invite after Delete my account gets its own). Skipped once they've signed
 * in. Never throws: a failed email never fails the invite. Logs the error's name only.
 */
export async function sendInviteEmail(
  email: string,
  deps: { send?: EmailSender } = {},
): Promise<InviteEmailOutcome> {
  try {
    const address = normalizeEmail(email);
    const [invite] = await db()
      .select({ invitedAt: invites.invitedAt, acceptedAt: invites.acceptedAt })
      .from(invites)
      .where(eq(invites.email, address));
    if (!invite || invite.acceptedAt) return "skipped";
    const id = `${inviteKey(address)}-${invite.invitedAt.getTime()}`;
    const marker = `invite-email:${id}`;
    const [seen] = await db().select().from(appSettings).where(eq(appSettings.key, marker));
    if (seen) return "already_sent";
    const c = inviteEmailCopy({
      signInUrl: appUrl("/signin"),
      operatorFirstName: siteConfig.operator.split(" ")[0]!,
      phone: siteConfig.phone,
    });
    const { text, html } = brandEmail({
      serif: c.serif,
      heavy: c.heavy,
      lines: c.lines,
      button: c.button,
      footer: c.footer,
    });
    const outcome = await (deps.send ?? sendEmail)({
      to: address,
      subject: c.subject,
      text,
      html,
      idempotencyKey: `invite-${id}`,
    });
    if (outcome === "not_configured") return "not_configured";
    await db()
      .insert(appSettings)
      .values({ key: marker, value: new Date().toISOString() })
      .onConflictDoNothing();
    return "sent";
  } catch (err) {
    console.error("invite_email_failed", emailErrorFields(err));
    return "failed";
  }
}
