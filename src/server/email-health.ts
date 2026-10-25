import "server-only";
import { brandEmail } from "@/lib/email-layout";
import { ResendError, refusedTally, sendEmail, type EmailSender } from "@/lib/email";
import { emailHealth, refusedLine, type EmailHealth } from "./email-health-rules";

/** What the /admin Email box shows: the sender's state and the week's refusal count. */
export async function emailHealthBox(
  now: Date = new Date(),
): Promise<{ health: EmailHealth; refused: string }> {
  return {
    health: emailHealth({
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      EMAIL_FROM: process.env.EMAIL_FROM,
    }),
    refused: refusedLine(await refusedTally(7, now)),
  };
}

export type TestEmailResult =
  { result: "sent" } | { result: "not_set_up" } | { result: "refused"; status: number };

/**
 * Check 18 P2: "Send me a test email" — a brand email to ADMIN_EMAIL (from env, never typed),
 * one per minute by idempotency key. Returns the result word and the Resend status; logs
 * nothing but the status.
 */
export async function sendAdminTestEmail(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<TestEmailResult> {
  const to = process.env.ADMIN_EMAIL?.trim();
  if (!to) return { result: "not_set_up" };
  const minute = now.toISOString().slice(0, 16);
  const { text, html } = brandEmail({
    serif: "testing,",
    heavy: "email works.",
    lines: [
      "This is the test email from the admin page. If you're reading it, Squared Away's emails reach this address.",
    ],
    footer: `Sent ${minute.replace("T", " at ")} UTC.`,
  });
  try {
    const outcome = await (deps.send ?? sendEmail)({
      to,
      subject: "Squared Away test email",
      text,
      html,
      idempotencyKey: `admin-test-${minute}`,
      // Addressed to Davi himself: no Reply-To (Check 18 P5).
      replyTo: null,
    });
    if (outcome === "not_configured") return { result: "not_set_up" };
    return { result: "sent" };
  } catch (err) {
    if (err instanceof ResendError) return { result: "refused", status: err.status };
    throw err;
  }
}
