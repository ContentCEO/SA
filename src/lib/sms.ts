import "server-only";
import { appUrl } from "./app-url";

/** Twilio refused the text. Carries Twilio's HTTP status only — never the number or the words. */
export class TwilioError extends Error {
  constructor(readonly status: number) {
    super(`Twilio ${status}.`);
    this.name = "TwilioError";
  }
}

export type OutgoingSms = {
  to: string;
  body: string;
  /**
   * Check 19 P8: seconds Twilio may hold the text before dropping it (ValidityPeriod; only
   * with a Messaging Service). Alerts pass the time left until the owner's 9pm.
   */
  validitySec?: number;
};
/** Check 19 P6: "sent" carries Twilio's message id, so its delivery report can be matched. */
export type SmsSendResult = { status: "sent"; sid: string } | "not_configured";
export type SmsSender = (sms: OutgoingSms) => Promise<SmsSendResult>;

/** Where Twilio reports each text's delivery (Check 19 P6). Signed with the auth token. */
export const twilioStatusUrl = () => appUrl("/api/twilio/status");

/**
 * Texts to the owner's own phone, via Twilio's HTTP API (no SDK). Needs
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either TWILIO_MESSAGING_SERVICE_SID
 * (preferred: handles STOP/HELP and the A2P registration) or TWILIO_FROM_NUMBER.
 * Without them nothing is sent and the caller is told so.
 */
export const sendSms: SmsSender = async ({ to, body, validitySec }) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || (!service && !from)) return "not_configured";
  const form = new URLSearchParams({ To: to, Body: body, StatusCallback: twilioStatusUrl() });
  if (service) {
    form.set("MessagingServiceSid", service);
    if (validitySec)
      form.set("ValidityPeriod", String(Math.max(1, Math.min(14_400, Math.floor(validitySec)))));
  } else form.set("From", from!);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) throw new TwilioError(res.status);
  const json = (await res.json().catch(() => null)) as { sid?: unknown } | null;
  return { status: "sent", sid: typeof json?.sid === "string" ? json.sid : "" };
};

export function smsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER),
  );
}
