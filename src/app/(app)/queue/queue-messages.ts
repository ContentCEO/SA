import { CONTROL_DONE, CONTROL_ERRORS } from "@/config/control-messages";

/** The ?done= notices on the Queue. */
export const QUEUE_DONE: Record<string, string> = {
  ...CONTROL_DONE,
  away_off: "Welcome back. Away mode is off.",
  discarded: "Draft discarded.",
  // Check 21 P8: from a nudge card.
  marked_lost: "Marked lost.",
  marked_paid: "Marked paid.",
  saved: "Changes saved. It's updated in Gmail too.",
  drafted: "Reply drafted. It's below, and in your Gmail drafts.",
  revised: "Draft changed. Read it below — it's updated in Gmail too.",
  practice:
    "Practice copy sent to your own inbox — your customer got nothing. The draft is still below.",
  undone: "Stopped. Nothing was sent — it's back below.",
  snoozed: "Snoozed. It'll come back to the top of the queue.",
  held: "Held. It won't send until you tap Send reply.",
  called:
    "Marked as answered by phone. No draft and no nudge for that one unless they write again.",
  done: "Marked done. It'll come back if they write again.",
  fixed: "Marked fixed. I'll remind you to check in with them in 2 days.",
  checkin_closed: "Good. That one's closed.",
  town_added: "Town added to your list. Draft a reply when you're ready.",
  // Check 22 P2: the owner said a flagged email was normal.
  normal_email:
    "Marked as a normal email. Autopilot still leaves this conversation to you for 30 days.",
  found_money:
    "Writing those drafts now. They show up below in a minute or two, and each one waits for you.",
};
/**
 * The ?error= notices on the Queue (and, for the Edit box, the same words inside the card).
 * Check 9 P3: every one a Send reply tap can reach says plainly whether anything was sent.
 */
export const QUEUE_ERRORS: Record<string, string> = {
  ...CONTROL_ERRORS,
  not_clearable:
    "That one has hidden or coded text in it, so it stays marked. Read it in Gmail before you answer.",
  // Check 23 P7: plain words, no braces.
  gaps: "Fill in every blank before sending. Nothing was sent.",
  // Check 9 P15: says plainly that nothing went.
  busy: "That's a lot in a short time, so nothing was sent. Try again in a few minutes.",
  blocked: "Sending isn't switched on for your account, so nothing was sent.",
  changed:
    "That draft changed since you opened it, so nothing was sent. Here's the latest version. Read it, then tap Send reply again.",
  deleted:
    "That draft was deleted or sent from Gmail, so it's gone from here too. Nothing was sent from here.",
  to_changed:
    "Who that reply goes to changed since you opened it, so nothing was sent. Check the To line, then tap Send reply again.",
  reconnect:
    "Google access was lost, so nothing was sent. Reconnect Gmail in Settings and try again.",
  empty: "The reply was empty, so nothing was sent.",
  exists: "There's already a draft for that one — it's below.",
  replied: "You've already replied to that one.",
  notext: "There's no email text left to reply to (older than 30 days).",
  capped: "Today's drafting limit is used up. It resets tomorrow.",
  revisions: "That draft has been changed as many times as it can be. Edit it by hand instead.",
  practice_limit: "That's all 10 practice sends. The real thing turns on once setup is paid.",
  toolate: "Too late to undo — that reply has already gone.",
  gone: "That draft isn't waiting any more, so nothing was sent.",
  snooze: "That can't be put off that long — it looks urgent. Pick an earlier time.",
  draftfailed: "Couldn't write a draft for that one. Try again in a minute.",
  // Check 48 P4: a slow, down or missing model on a tap.
  ai_busy: "Writing is slow right now, so nothing changed. Try again in a moment.",
  gmail_busy: "Gmail asked us to slow down. Nothing was sent. Try again in a minute.",
  gmail_failed: "Gmail didn't answer, so nothing was sent. Try again in a minute.",
  // Check 43 P7.
  timing:
    "That reply has time words that may be out of date, so nothing was sent. Read the note on the card, then tap Send reply anyway or Edit.",
  gmail_busy_discard:
    "Gmail asked us to slow down, so the draft is still here and in Gmail. Try again in a minute.",
  gmail_failed_discard:
    "Gmail didn't answer, so the draft is still here and in Gmail. Try again in a minute.",
  reply_to_unread: "We couldn't check who this goes to. Try again in a minute.",
  no_reply_address:
    "That one would go to a no-reply address, so nothing was sent. Answer them on the platform or by phone.",
  textaddr:
    "That address turns email into a text message, and Squared Away never texts customers, so nothing was sent. Use Text from my phone instead.",
  leadsite: "That one came through a lead website — answer them on the website.",
  phonemsg: "That's a voicemail or text message — call or text them back from your phone.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  // Deposit / review / closing notes (plan #26 #28 #29).
  purpose_not_allowed: "That one isn't ready for that kind of note.",
  not_eligible: "That one isn't ready for that kind of note.",
  feature_off: "That isn't switched on for your account yet.",
  already_asked: "You've already asked them once.",
  thanked: "You've already written them a thank-you for that one.",
  no_review_link: "Add your review link in Settings → Business profile first.",
  review_recent: "You asked them for a review in the last 12 months.",
  complaint: "Not for a complaint — reply to that one yourself.",
  has_draft: "Send or discard the reply first.",
  // Check 9 P2: Hold it never says "Held." for a reply that went.
  autopilot_sending:
    "Too late to hold: autopilot is sending it right now. It shows on Activity in a minute.",
  changed_editing:
    "This reply changed while you were editing. Here's the newest version; make your change again. Nothing was sent.",
  hold_gone: "That reply isn't counting down any more, so there was nothing to hold.",
  paused:
    "That Gmail address is paused on your plan, so nothing was sent or written. Pick which one is on in Settings → Your Gmail.",
  unknown: "That didn't work, and nothing was sent. Refresh and try again.",
};
