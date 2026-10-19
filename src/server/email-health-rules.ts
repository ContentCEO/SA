/**
 * Check 18 P2: whether the app's own emails (invite, first drafts, morning and monthly
 * summaries, access-lost alerts, waitlist confirmation) can reach owners, in plain words for
 * /admin. Pure: reads only the two env values it is handed and a count-only tally. The sender
 * address is the app's own, never an owner's.
 */

export type EmailHealth =
  | { state: "not_set_up"; line: string }
  | { state: "test_sender"; line: string }
  | { state: "real"; line: string };

/** The address inside EMAIL_FROM ("Name <a@b.com>" or "a@b.com"), lowercased, or null. */
export function emailAddressOf(from: string | undefined): string | null {
  if (!from?.trim()) return null;
  const m =
    /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from.trim()) ?? /^([^<>\s]+@[^<>\s]+)$/.exec(from.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Resend's shared test sender only delivers to the Resend account's own address (403 otherwise). */
export function isResendTestSender(address: string | null): boolean {
  if (!address) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return domain === "resend.dev" || domain.endsWith(".resend.dev");
}

export const EMAIL_NOT_SET_UP = "Not set up: no email goes out.";
export const EMAIL_TEST_SENDER =
  "Test sender: emails only reach the Resend account's own address. Verify your domain in Resend (launch notes step 6).";

export function emailHealth(env: {
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
}): EmailHealth {
  const address = emailAddressOf(env.EMAIL_FROM);
  if (!env.RESEND_API_KEY?.trim() || !address) {
    return { state: "not_set_up", line: EMAIL_NOT_SET_UP };
  }
  if (isResendTestSender(address)) return { state: "test_sender", line: EMAIL_TEST_SENDER };
  return { state: "real", line: `Sending from ${address}.` };
}

/** "Refused in the last 7 days: 3 (most often: 403)." from the count-only tally. */
export function refusedLine(
  t: { total: number; byStatus: Record<string, number> },
  days = 7,
): string {
  if (!t.total) return `Refused in the last ${days} days: 0.`;
  const [top] = Object.entries(t.byStatus).sort(
    (a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]),
  );
  return `Refused in the last ${days} days: ${t.total} (most often: ${top![0]}).`;
}

/** The test button's result, in one word each (fixed codes travel in the URL, nothing else). */
export const TEST_EMAIL_DONE: Record<string, string> = {
  email_test_sent: "Test email: sent. Look in your inbox.",
  email_test_not_set_up: "Test email: not set up, so nothing went out.",
};
export const TEST_EMAIL_ERRORS: Record<string, string> = {
  email_test_refused: "Test email: refused",
  email_test_limit: "Test email: you've sent five this hour. Try again later.",
};

/** The refused line with its status, when the URL carries a valid three-digit one. */
export function testEmailErrorText(code: unknown, status: unknown): string | undefined {
  if (typeof code !== "string" || !(code in TEST_EMAIL_ERRORS)) return undefined;
  const base = TEST_EMAIL_ERRORS[code]!;
  if (code !== "email_test_refused") return base;
  return typeof status === "string" && /^\d{3}$/.test(status) ? `${base} ${status}.` : `${base}.`;
}

/** Check 18 P4: "Sent 7, 2 failed." from the catch-up's counts (digits only, from the URL). */
export function catchUpResultText(
  sent: unknown,
  failed: unknown,
  left: unknown,
): string | undefined {
  const n = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) ? Number(v) : null);
  const s = n(sent);
  const f = n(failed);
  const l = n(left);
  if (s === null || f === null) return undefined;
  const base = `Sent ${s}, ${f} failed.`;
  return l ? `${base} ${l} still to go: tap again.` : base;
}
