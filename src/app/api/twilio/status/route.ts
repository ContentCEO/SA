import { NextResponse, type NextRequest } from "next/server";
import { twilioStatusUrl } from "@/lib/sms";
import { twilioSignatureOk } from "@/lib/twilio-signature";
import { applyTwilioStatus } from "@/server/sms-deliveries";

export const dynamic = "force-dynamic";

/**
 * Check 19 P6: Twilio's delivery report for a text we sent the owner (StatusCallback). Only
 * a request signed with TWILIO_AUTH_TOKEN over the exact callback URL we gave Twilio is read
 * (403 otherwise). Stores the status and error code by message id — never a body or number.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (
    !twilioSignatureOk(
      process.env.TWILIO_AUTH_TOKEN,
      twilioStatusUrl(),
      params,
      request.headers.get("x-twilio-signature"),
    )
  ) {
    return new NextResponse(null, { status: 403 });
  }
  const sid = params.MessageSid ?? params.SmsSid;
  const status = params.MessageStatus ?? params.SmsStatus;
  if (sid && status) {
    const code = Number.parseInt(params.ErrorCode ?? "", 10);
    await applyTwilioStatus(sid, status, Number.isFinite(code) ? code : null);
  }
  return new NextResponse(null, { status: 204 });
}
