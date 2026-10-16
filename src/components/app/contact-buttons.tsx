import { smsHref, telHref, type E164 } from "@/lib/phone-numbers";

/**
 * Leads package (B4): Call / Text from the owner's own phone. Plain tel: / sms: links — the
 * call or text goes from their phone, never from Squared Away, which never calls or texts a
 * customer. Visible words only (no aria-label carrying a name: the Sentry rule).
 */
export function ContactButtons({
  phone,
  phoneShown,
  firstName,
  textBody,
  callLabel,
  callFirst = false,
  inverted = false,
}: {
  phone: E164;
  phoneShown: string;
  firstName: string | null;
  textBody: string;
  /** "Call back" on a voicemail; else "Call Dana" / "Call them". */
  callLabel?: string;
  /** Emergencies and complaints: Call is a full-width first button. */
  callFirst?: boolean;
  inverted?: boolean;
}) {
  const who = firstName ?? "them";
  const call = callLabel ?? `Call ${who}${callFirst ? " now" : ""}`;
  const base =
    "inline-flex min-h-tap items-center justify-center rounded-lg px-4 text-center font-black";
  const solid = inverted ? `${base} bg-paper text-charcoal` : `${base} bg-charcoal text-paper`;
  const outline = `${base} border-2 border-current`;
  return (
    <div className="flex flex-col gap-1">
      <div className={callFirst ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-2"}>
        <a href={telHref(phone)} className={solid}>
          {call}
        </a>
        <a href={smsHref(phone, textBody)} className={outline}>
          Text {who}
        </a>
      </div>
      <p className="text-sm">
        {phoneShown} · from their email. Calls and texts go from your own phone.
      </p>
    </div>
  );
}
