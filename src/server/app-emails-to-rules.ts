/**
 * Check 42 P6: which address gets the app's own emails (the morning and monthly summaries, the
 * "Gmail access lost" alerts, "Your first drafts are ready"). They go to the Google account the
 * owner signs in with, which is often not the inbox the shop works from. Pure: the words only;
 * the address comes from the session and is never logged.
 */

const normalize = (s: string) => s.trim().toLowerCase();

export function appEmailsGoTo(
  kind: "digest" | "access",
  signInEmail: string,
  connectedEmails: readonly string[],
): string[] {
  const first =
    kind === "digest"
      ? `Goes to ${signInEmail} (the Google account you sign in with).`
      : `If Google access stops, we email ${signInEmail} (your sign-in).`;
  const connected = connectedEmails.map(normalize).includes(normalize(signInEmail));
  return connected
    ? [first]
    : [first, "That's not one of the inboxes connected here, so check it is one you read."];
}
