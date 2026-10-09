/** Opens the thread in the right Gmail account (the mailbox it was synced from). */
export function gmailThreadLink(t: { mailboxEmail: string; gmailThreadId: string }) {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(t.mailboxEmail)}#all/${t.gmailThreadId}`;
}
