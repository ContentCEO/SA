/**
 * The fixed answers and the fake inbox the e2e fakes serve (Milestone 11). Pure: imports
 * nothing from src/, so the fake server can run on its own with tsx. tests/unit/e2e-fakes.test.ts
 * checks every output against the real schemas, draft checks and owner rules, so a prompt
 * change that breaks them fails a unit test, not a slow browser run.
 *
 * Everything here is invented. The customer is always "Dana Ruiz"; each scenario gets its own
 * `ref` (in the subject, the bodies and every address) so parallel tests never share mail and
 * the fake can tell which test a model call belongs to.
 */

/** Classification (classify.v4): a plain quote request that auto-drafts. */
export const FAKE_CLASSIFICATION = {
  category: "quote_request",
  priority: "normal",
  needs_owner: false,
  needs_owner_reason: null,
  summary: "Dana wants a quote to replace a 40-gallon gas water heater.",
  confidence: 0.92,
  signals: {
    mentions_legal: false,
    mentions_refund_or_dispute: false,
    large_request: false,
    from_building_department: false,
    tries_to_instruct_assistant: false,
    accepts_quote: false,
    job_done: false,
    routine_paperwork: false,
    payment_change_request: false,
    smells_gas: false,
  },
  extracted: {
    service_requested: "water heater replacement",
    address: null,
    dates: [],
    dollar_amounts: [],
    urgency: "normal",
    permit: null,
    invoice: null,
    invoice_direction: "unknown",
  },
} as const;

/**
 * Draft (draft.v6 and the other prompts that share its shape). No $, weekday, date, time,
 * promise word, filler or {{gap}}: checkDraft finds nothing, so there is no regenerate.
 */
export const FAKE_DRAFT = {
  body: [
    "Hi Dana,",
    "",
    "Thanks for the details on the water heater. Could you send a photo of the tank and the space around it, plus the address? Then I can put a price together for you.",
    "",
    "Thanks,",
    "Mike",
  ].join("\n"),
  reason: "Quote request for a water heater swap. Asked for a photo and the address first.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
} as const;

/** Voice (voice.v2): placeholders only, as the real prompt asks. */
export const FAKE_VOICE = {
  summary: "Short, friendly and straight to the point.",
  greeting_style: "Hi",
  signoff_style: "Thanks, Mike",
  avg_length_words: 60,
  formality: "casual",
  phrases_used: ["sounds good", "happy to help", "talk soon"],
  phrases_avoided: ["I hope this email finds you well"],
  examples: [
    "Hi [name], thanks for the photos. I can take a look and get you a price.",
    "Hi [name], sounds good. I'll bring the parts with me.",
    "Hi [name], happy to help. What's the address?",
    "Hi [name], all done. Let me know if anything acts up.",
    "Hi [name], thanks for sending that over. Talk soon.",
  ],
} as const;

/** Edit tone (edit-tone.v1). */
export const FAKE_EDIT_TONE = { tone_shift: "none" } as const;

export type FakeOutputKind = "classify" | "draft" | "voice" | "edit_tone";

/**
 * Which prompt a structured request is, from the property names of its output schema (the
 * JSON schema zodOutputFormat sends): only the classifier has `category`, only edit-tone has
 * `tone_shift`, only voice has `formality`; draft, follow-up, revise and purpose share `body`.
 */
export function outputKindFor(schemaProperties: string[]): FakeOutputKind | null {
  const has = (k: string) => schemaProperties.includes(k);
  if (has("category")) return "classify";
  if (has("tone_shift")) return "edit_tone";
  if (has("formality")) return "voice";
  if (has("body")) return "draft";
  return null;
}

export function fakeOutput(kind: FakeOutputKind): unknown {
  switch (kind) {
    case "classify":
      return FAKE_CLASSIFICATION;
    case "draft":
      return FAKE_DRAFT;
    case "voice":
      return FAKE_VOICE;
    case "edit_tone":
      return FAKE_EDIT_TONE;
  }
}

/** A message in the fake mailbox, before it's turned into Gmail's JSON. */
export type FakeMail = {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Epoch millis. */
  internalDate: number;
  headers: { name: string; value: string }[];
  body: string;
};

/** A scenario's short tag: the first 12 hex digits of its id (a random UUID). */
export function refFor(scenarioId: string): string {
  return scenarioId.replace(/-/g, "").slice(0, 12).toLowerCase();
}

/**
 * How the lead arrives: Dana writes herself ("direct"), or a website contact form emails the
 * owner from its robot address with Dana in Reply-To ("form", Squarespace's layout).
 */
export type FakeLead = "direct" | "form";

/** A Squarespace form's robot sender: a reply must never go here. */
export const FORM_ROBOT = { name: "Squarespace", email: "form-submission@squarespace.info" };

/** The customer's side of a scenario: what the spec asserts the reply is threaded to. */
export function fakeCustomer(ref: string, lead: FakeLead = "direct") {
  if (lead === "form") {
    // Not on example.com: the e2e owners are, and a Reply-To on the owner's own business
    // domain is never taken as a customer's (a form set to reply to the shop itself).
    const email = `dana-${ref}@example.net`;
    return {
      name: "Dana Ruiz",
      firstName: "Dana",
      email,
      from: `${FORM_ROBOT.name} <${FORM_ROBOT.email}>`,
      replyTo: `Dana Ruiz <${email}>`,
      subject: `Form Submission - Request a quote, ref ${ref}`,
      messageIdHeader: `<cust-${ref}@mail.example.com>`,
      gmailMessageId: `msg-${ref}-cust`,
      gmailThreadId: `thr-${ref}-cust`,
      body: [
        "Name: Dana Ruiz",
        `Email: ${email}`,
        "Phone: (555) 010-0199",
        `Message: Could you give me a quote to replace the water heater in our basement? It's a 40 gallon gas tank, about 12 years old, and it's started to leak a little at the bottom. (Ref ${ref})`,
        "",
        "Sent via form submission from Ruiz Plumbing.",
      ].join("\n"),
    };
  }
  return {
    name: "Dana Ruiz",
    firstName: "Dana",
    email: `dana-${ref}@example.com`,
    from: `Dana Ruiz <dana-${ref}@example.com>`,
    replyTo: null as string | null,
    subject: `Water heater quote, ref ${ref}`,
    messageIdHeader: `<cust-${ref}@mail.example.com>`,
    gmailMessageId: `msg-${ref}-cust`,
    gmailThreadId: `thr-${ref}-cust`,
    body: [
      "Hi,",
      "",
      `Could you give me a quote to replace the water heater in our basement? It's a 40 gallon gas tank, about 12 years old, and it's started to leak a little at the bottom. (Ref ${ref})`,
      "",
      "Thanks,",
      "Dana",
    ].join("\n"),
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The fake inbox: one customer email (INBOX, an hour old) and five older sent emails on other
 * threads, enough for voice learning (MIN_SENT_EMAILS = 5). Each sent body is long enough to
 * count (≥20 characters after quoted text is stripped).
 */
export function buildInbox(
  ref: string,
  ownerEmail: string,
  now = Date.now(),
  opts: { lead?: FakeLead } = {},
): FakeMail[] {
  const c = fakeCustomer(ref, opts.lead);
  const customer: FakeMail = {
    id: c.gmailMessageId,
    threadId: c.gmailThreadId,
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    internalDate: now - HOUR,
    headers: [
      { name: "From", value: c.from },
      ...(c.replyTo ? [{ name: "Reply-To", value: c.replyTo }] : []),
      { name: "To", value: ownerEmail },
      { name: "Subject", value: c.subject },
      { name: "Message-ID", value: c.messageIdHeader },
      { name: "Date", value: new Date(now - HOUR).toUTCString() },
    ],
    body: c.body,
  };
  const names = ["Sam", "Priya", "Luis", "Kim", "Joe"];
  const sent: FakeMail[] = names.map((name, i) => ({
    id: `msg-${ref}-s${i}`,
    threadId: `thr-${ref}-s${i}`,
    labelIds: ["SENT"],
    internalDate: now - (i + 2) * DAY,
    headers: [
      { name: "From", value: ownerEmail },
      { name: "To", value: `${name.toLowerCase()}-${ref}@example.com` },
      { name: "Subject", value: `Re: your job, ref ${ref}` },
      { name: "Message-ID", value: `<sent-${ref}-${i}@mail.example.com>` },
      { name: "Date", value: new Date(now - (i + 2) * DAY).toUTCString() },
    ],
    body: [
      `Hi ${name},`,
      "",
      "Sounds good. I'll bring the parts with me and we'll have it sorted in an afternoon.",
      `Happy to help, talk soon. (Ref ${ref})`,
      "",
      "Thanks,",
      "Mike",
    ].join("\n"),
  }));
  return [customer, ...sent];
}
