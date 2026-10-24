import { OUTLOOK_REMOVE_ACCESS } from "@/lib/outlook-words";

/**
 * The notices each Settings screen shows after a save (`?done=`) or a refusal (`?error=`).
 * One map per screen, keyed by its own path; every redirect in the settings actions names a
 * screen and a code listed here (tests/unit/settings-redirects.test.ts checks it).
 */
type Messages = { done: Record<string, string>; error: Record<string, string> };

const UNKNOWN = "That didn't work. Refresh and try again.";

export const SCREEN_MESSAGES = {
  "/settings/gmail": {
    done: {
      connected: "Gmail connected.",
      disconnected: "Gmail disconnected. We've removed our access at Google.",
      disconnected_outlook: `Outlook disconnected. ${OUTLOOK_REMOVE_ACCESS}`,
      swapped: "Done. That Gmail is on now, and the other one is paused.",
      resumed: "Done. That Gmail is on now.",
    },
    error: {
      limit: "Your plan is at its mailbox limit. Disconnect one first, or ask about a bigger plan.",
      choose: "Pick which Gmail to pause instead.",
      busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
      unknown: UNKNOWN,
    },
  },
  "/settings/business": {
    done: {
      profile: "Business profile saved.",
      note_added: "Note added. Drafts will use it until its last day.",
      note_removed: "Note removed.",
      work_hours: "Working days saved. Alerts about waiting leads follow them.",
    },
    error: {
      note_invalid: "Write a short note and pick its last day.",
      note_past: "That date has already passed.",
      note_too_far: "Pick a date within the next year.",
      note_full: "You can have 5 notes at once. Remove one first.",
      work_days: "Pick at least one day.",
      work_hours: "Your day has to end after it starts.",
      unknown: UNKNOWN,
    },
  },
  "/settings/writing": {
    done: {
      voice: "Saved how you write.",
      never_say: "Never-say list saved.",
      languages: "Saved. New drafts follow it.",
      // Check 15 P5: {saved} and {skipped} are filled from the numbers in the address.
      never_say_skipped:
        "Saved {saved}. Skipped {skipped} (each needs 2 to 80 characters, up to 50 lines).",
      relearn: "Re-reading your sent mail. This takes a minute or two.",
      idea_yes: "Done. New drafts will be written that way.",
      idea_no: "Okay — nothing changed.",
    },
    error: {
      relearn_busy: "Your sent mail was re-read recently. You can do it again tomorrow.",
      unknown: UNKNOWN,
    },
  },
  "/settings/follow-ups": {
    done: { saved: "Saved." },
    error: { unknown: UNKNOWN },
  },
  "/settings/autopilot": {
    done: {
      autopilot_on:
        "Autopilot is on for that kind of email. You'll get 10 minutes to hold each one.",
      autopilot_off:
        "Autopilot is off for that kind of email. Those replies wait for your tap again.",
    },
    error: { autopilot: "Autopilot can't be turned on for that yet." },
  },
  "/settings/morning-email": {
    done: { saved: "Saved.", zone: "Time zone saved." },
    error: { unknown: UNKNOWN, zone: "That time zone didn't work. Pick one from the list." },
  },
  "/settings/notifications": { done: { saved: "Saved." }, error: {} },
  "/settings/texts": {
    done: {
      sms_code: "Code sent. Type it in below.",
      sms_on: "Text alerts are on.",
      sms_off: "Text alerts are off.",
      sms_removed: "Number removed.",
      saved: "Saved.",
    },
    error: {
      sms_phone: "That doesn't look like a US mobile number.",
      sms_busy: "Too many tries. Wait an hour and try again.",
      sms_code: "That code didn't match, or it expired. Send a new one.",
      sms_not_configured: "Texting isn't switched on yet.",
      sms_not_verified: "Confirm your number first.",
      sms_send_failed: "We couldn't text that number. Check it's a mobile number and try again.",
      // Check 27 P6: Twilio's 21610 when the code is sent.
      sms_opted_out:
        "That number replied STOP to our texts. Text START to the number, then try again.",
    },
  },
  "/settings/away": {
    done: {
      away_on: "Away mode is on.",
      away_off: "Welcome back. Away mode is off.",
    },
    error: {
      away_past: "Pick a day after today.",
      away_too_far: "Pick a day in the next 90 days.",
      away_invalid: "Pick the day you're back.",
      readonly:
        "Your account is read-only right now, so nothing was changed. The note at the top says why.",
      unknown: UNKNOWN,
    },
  },
  "/settings/sender-rules": {
    done: { rule_removed: "Rule removed." },
    error: { unknown: UNKNOWN },
  },
  "/settings/phone": {
    done: { saved: "Saved for this phone." },
    error: {},
  },
  "/settings/account": {
    done: {},
    error: {
      delete_billing:
        "We couldn't cancel your plan, so nothing was deleted. Try again, or call us and we'll do it.",
      // Check 26 P4.
      confirm: "Type DELETE to confirm.",
    },
  },
} satisfies Record<string, Messages>;

export type SettingsScreenPath = keyof typeof SCREEN_MESSAGES;

/**
 * Old bookmarks and links (`/settings?done=…`) still get their notice on the list. Codes that
 * mean "saved" on the old page are kept so an old link reads the same.
 */
export const LIST_MESSAGES: Messages = {
  done: Object.assign(
    {
      followups: "Follow-up settings saved.",
      digest: "Morning summary saved.",
      hand: "Saved for this phone.",
      offline: "Saved for this phone.",
    },
    ...Object.values(SCREEN_MESSAGES).map((m) =>
      Object.fromEntries(Object.entries(m.done).filter(([code]) => code !== "saved")),
    ),
  ),
  error: Object.assign({}, ...Object.values(SCREEN_MESSAGES).map((m) => m.error)),
};
