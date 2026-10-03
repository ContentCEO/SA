import "server-only";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key within 24h = Resend sends it once, so job retries can't double-send. */
  idempotencyKey: string;
};

export type EmailSender = (email: OutgoingEmail) => Promise<"sent" | "not_configured">;

/**
 * Our own emails to owners (the digest), via Resend's HTTP API. Needs
 * RESEND_API_KEY and EMAIL_FROM ("Squared Away <hello@yourdomain>"); without
 * them nothing is sent and the caller is told so.
 */
export const sendEmail: EmailSender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return "not_configured";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": email.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}.`);
  return "sent";
};
