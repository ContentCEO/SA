/**
 * Phone services that email the owner (leads package, B3) and the carriers' email-to-text
 * gateways (B4 / safety). Code decides from these lists — never the AI.
 *
 * PHONE_SERVICES: a voicemail-by-email sender, matched on the exact address. Only Google Voice
 * for now; RingCentral, Grasshopper and OpenPhone get one line each once a real sample shows
 * their sender (Waiting on Davi).
 */
export type PhoneService = { key: string; label: string; senders: readonly string[] };

export const PHONE_SERVICES: readonly PhoneService[] = [
  { key: "google_voice", label: "Google Voice", senders: ["voice-noreply@google.com"] },
];

/**
 * Domains where an email becomes a text message on someone's phone. A reply there would text
 * the customer, and Squared Away never texts customers: drafts and sends to these are refused
 * in code. Sources: each carrier's own published email-to-text / email-to-MMS help page
 * (Google Voice txt.voice.google.com and Google Fi msg.fi.google.com, Verizon vtext.com /
 * vzwpix.com, AT&T txt.att.net / mms.att.net, T-Mobile tmomail.net, Sprint
 * messaging.sprintpcs.com / pm.sprint.com, Cricket sms./mms.cricketwireless.net, Boost
 * sms.myboostmobile.com / myboostmobile.com, Metro mymetropcs.com, US Cellular email.uscc.net /
 * mms.uscc.net, Consumer Cellular mailmymobile.net, Tracfone mmst5.tracfone.com,
 * mypixmessages.com). A domain matches itself and its subdomains.
 */
export const EMAIL_TO_TEXT_DOMAINS: readonly string[] = [
  "txt.voice.google.com",
  "msg.fi.google.com",
  "vtext.com",
  "vzwpix.com",
  "mypixmessages.com",
  "txt.att.net",
  "mms.att.net",
  "tmomail.net",
  "messaging.sprintpcs.com",
  "pm.sprint.com",
  "sms.cricketwireless.net",
  "mms.cricketwireless.net",
  "sms.myboostmobile.com",
  "myboostmobile.com",
  "mymetropcs.com",
  "email.uscc.net",
  "mms.uscc.net",
  "mailmymobile.net",
  "mmst5.tracfone.com",
];
