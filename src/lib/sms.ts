import "server-only";

export type OutgoingSms = { to: string; body: string };
export type SmsSender = (sms: OutgoingSms) => Promise<"sent" | "not_configured">;

/**
 * Texts to the owner's own phone, via Twilio's HTTP API (no SDK). Needs
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either TWILIO_MESSAGING_SERVICE_SID
 * (preferred: handles STOP/HELP and the A2P registration) or TWILIO_FROM_NUMBER.
 * Without them nothing is sent and the caller is told so.
 */
export const sendSms: SmsSender = async ({ to, body }) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || (!service && !from)) return "not_configured";
  const form = new URLSearchParams({ To: to, Body: body });
  if (service) form.set("MessagingServiceSid", service);
  else form.set("From", from!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}.`);
  return "sent";
};

export function smsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER),
  );
}
