import { describe, expect, it } from "vitest";
import {
  buildReplyMime,
  encodeHeader,
  formatAddress,
  formReplySubject,
  replySubject,
  sameText,
  textToHtml,
  toGmailRaw,
} from "@/mailbox/mime";
import { extractBodyText } from "@/mailbox/gmail/parse";
import {
  NO_SIGNATURE_LINE,
  noSignatureLine,
  pickFromAddress,
  pickSenderName,
} from "@/server/from-line-rules";
import { FakeWriter } from "../support/fake-writer";

describe("reply MIME", () => {
  const mime = buildReplyMime({
    from: "owner@shop.com",
    to: "dana@x.com",
    subject: "Re: Panel upgrade",
    inReplyTo: "<abc@mail.x.com>",
    references: "<first@mail.x.com>",
    body: "Hey Dana,\nWhat's the address?\n\nThanks, Davi",
  });

  it("threads the reply with In-Reply-To and References", () => {
    expect(mime).toContain("In-Reply-To: <abc@mail.x.com>");
    expect(mime).toContain("References: <first@mail.x.com> <abc@mail.x.com>");
    expect(mime).toContain("To: dana@x.com");
  });

  it("round-trips the body as UTF-8", () => {
    const withAccent = buildReplyMime({
      from: "a@b.c",
      to: "d@e.f",
      subject: "x",
      body: "Café at 8 — sounds good",
    });
    expect(FakeWriter.bodyOf(toGmailRaw(withAccent))).toBe("Café at 8 — sounds good");
    expect(FakeWriter.bodyOf(toGmailRaw(mime))).toBe(
      "Hey Dana,\nWhat's the address?\n\nThanks, Davi",
    );
  });

  it("can't be used to inject headers", () => {
    const evil = buildReplyMime({
      from: "owner@shop.com",
      to: "dana@x.com\r\nBcc: everyone@evil.com",
      subject: "Hi\r\nBcc: more@evil.com",
      inReplyTo: "<a@b>\nX-Evil: 1",
      body: "x",
    });
    const headers = evil.split("\r\n\r\n")[0]!;
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).not.toMatch(/^X-Evil:/m);
  });

  it("encodes non-ASCII subjects and adds Re: once", () => {
    expect(encodeHeader("Café")).toMatch(/^=\?UTF-8\?B\?/);
    expect(replySubject("Panel upgrade")).toBe("Re: Panel upgrade");
    expect(replySubject("RE: Panel upgrade")).toBe("RE: Panel upgrade");
    expect(replySubject(null)).toBe("Re: your email");
  });

  it("treats whitespace-only differences as the same text", () => {
    expect(sameText("Hi\r\nthere  \n\n\n", "Hi\nthere")).toBe(true);
    expect(sameText("Hi there", "Hi, there")).toBe(false);
  });
});

/** RFC 2047 =?UTF-8?B?…?= words back to text (adjacent words joined, as RFC 2047 says). */
const decodeWords = (v: string) =>
  v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b: string) =>
      Buffer.from(b, "base64").toString("utf8"),
    );
const headerLines = (mime: string) => mime.split("\r\n\r\n")[0]!.split("\r\n");
const fromHeader = (mime: string) =>
  headerLines(mime)
    .join("\r\n")
    .match(/^From: (.*(?:\r\n[ \t].*)*)/m)![1]!;

describe("Check 43 P3: the owner's name in the From line", () => {
  const reply = (fromName?: string | null) =>
    buildReplyMime({ from: "mike@x.com", fromName, to: "dana@y.com", subject: "Hi", body: "x" });

  it("puts a plain name in quotes", () => {
    expect(fromHeader(reply("Mike Rossi"))).toBe('"Mike Rossi" <mike@x.com>');
    expect(formatAddress("Rossi Plumbing & Heating", "mike@x.com")).toBe(
      '"Rossi Plumbing & Heating" <mike@x.com>',
    );
  });

  it("encodes an accented name so it decodes back", () => {
    const from = fromHeader(reply("José Ramírez"));
    expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <mike@x\.com>$/);
    expect(decodeWords(from)).toBe("José Ramírez <mike@x.com>");
    expect(from).toMatch(/^[\x20-\x7e]*$/);
  });

  it("can't be broken by a quote, a backslash or a line break in the name", () => {
    expect(formatAddress('Mike "The Pipe" Rossi\\', "mike@x.com")).toBe(
      '"Mike \\"The Pipe\\" Rossi\\\\" <mike@x.com>',
    );
    const evil = reply("Mike\r\nBcc: everyone@evil.com");
    expect(evil.split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/m);
    expect(fromHeader(evil)).toBe('"Mike Bcc: everyone@evil.com" <mike@x.com>');
  });

  it("keeps today's bare address when there is no name", () => {
    expect(fromHeader(reply())).toBe("mike@x.com");
    expect(fromHeader(reply(null))).toBe("mike@x.com");
    expect(fromHeader(reply("  "))).toBe("mike@x.com");
  });

  it("picks the owner's choice, then the Google name, then the business", () => {
    expect(pickSenderName({ fromName: "Mike", userName: "Michael R", businessName: "Rossi" })).toBe(
      "Mike",
    );
    expect(pickSenderName({ fromName: " ", userName: "Michael R", businessName: "Rossi" })).toBe(
      "Michael R",
    );
    expect(pickSenderName({ fromName: null, userName: null, businessName: "Rossi" })).toBe("Rossi");
    expect(pickSenderName({})).toBeNull();
    expect(pickSenderName({ fromName: "x".repeat(200) })).toHaveLength(80);
  });
});

describe("Check 42 P4: reply from the address the customer wrote to", () => {
  const base = { mailboxEmail: "mike@rossi.com", sendAs: ["mike@rossi.com", "office@rossi.com"] };
  it("picks the alias in To, else the connected address", () => {
    expect(pickFromAddress({ ...base, to: ["office@rossi.com"], cc: [] })).toBe("office@rossi.com");
    expect(pickFromAddress({ ...base, to: ["Office@Rossi.com"], cc: [] })).toBe("office@rossi.com");
    expect(pickFromAddress({ ...base, to: ["mike@rossi.com"], cc: [] })).toBe("mike@rossi.com");
    expect(pickFromAddress({ ...base, to: ["someone@else.com"], cc: [] })).toBe("mike@rossi.com");
  });
  it("never uses an alias Gmail hasn't verified (not in the list)", () => {
    expect(pickFromAddress({ ...base, to: ["info@rossi.com"], cc: [] })).toBe("mike@rossi.com");
    expect(pickFromAddress({ ...base, sendAs: [], to: ["office@rossi.com"], cc: [] })).toBe(
      "mike@rossi.com",
    );
  });
  it("finds the alias in Cc", () => {
    expect(pickFromAddress({ ...base, to: ["dana@x.com"], cc: ["office@rossi.com"] })).toBe(
      "office@rossi.com",
    );
  });
  it("puts the alias in a clean From header", () => {
    const mime = buildReplyMime({
      from: "office@rossi.com",
      fromName: "Rossi Plumbing",
      to: "dana@x.com",
      subject: "Re: Hi",
      body: "x",
    });
    expect(mime).toContain('From: "Rossi Plumbing" <office@rossi.com>\r\n');
    expect(formatAddress(null, "office@rossi.com\r\nBcc: x@y.com")).toBe(
      "office@rossi.com Bcc: x@y.com",
    );
  });
});

describe("Check 43 P4: the 'No signature' line", () => {
  it("shows only while the signature is empty", () => {
    expect(noSignatureLine(null)).toBe("No signature. Customers won't see your phone number.");
    expect(noSignatureLine("  \n ")).toBe(NO_SIGNATURE_LINE);
    expect(noSignatureLine("Mike\n978-555-0142")).toBeNull();
  });
});

describe("Check 43 P5: contact-form replies get a subject the homeowner recognises", () => {
  const shop = "Rossi Plumbing";
  it.each([
    ["Squarespace", "Form Submission - Request a quote"],
    ["Squarespace (new form)", "Form Submission - New Form"],
    ["Wix", "New Form Submission: Contact Us"],
    ["Wix inbox", "You have a new message from Website Inquiry"],
    ["WPForms", "New Entry: Contact Form"],
    ["Contact Form 7", 'Rossi Plumbing "Contact form"'],
    ["Jobber", "New request from Dana Ruiz"],
    ["Housecall Pro", "New lead from your website"],
    ["Generic", "New inquiry from rossiplumbing.com"],
  ])("%s: %s", (_tool, subject) => {
    expect(formReplySubject(subject, shop)).toBe("Your request to Rossi Plumbing");
    expect(formReplySubject(subject, null)).toBe("Your request");
  });
  it("keeps an ordinary subject as Re:", () => {
    expect(formReplySubject("Leaky faucet in the kitchen", shop)).toBe(
      "Re: Leaky faucet in the kitchen",
    );
    expect(formReplySubject("Re: Deck stain", shop)).toBe("Re: Deck stain");
    expect(formReplySubject(null, shop)).toBe("Re: your email");
  });
  it("can't carry a line break into the header", () => {
    expect(formReplySubject("Form Submission", "Rossi\r\nBcc: x@y.com")).toBe(
      "Your request to Rossi Bcc: x@y.com",
    );
  });
});

describe("Check 43 P6: a matching HTML part so Outlook can't squash signatures", () => {
  const text =
    'Hi Dana,\n\nI can come Monday,\nTuesday or Friday.\n\nPrices < $500 & "José" 🙏 it\'s fine: https://x.com/a?b=1&c=2\n\nMike Rossi\nRossi Plumbing & Heating\n978-555-0142';
  const mime = buildReplyMime({
    from: "mike@x.com",
    to: "dana@y.com",
    subject: "Re: Hi",
    inReplyTo: "<a@b>",
    body: text,
  });
  const raw = toGmailRaw(mime);
  /** The HTML part back to text: paragraphs → blank lines, <br> → newlines, entities decoded. */
  const htmlBack = (html: string) =>
    html
      .replace(/^<div dir="auto" style="font-family:inherit">|<\/div>$/g, "")
      .replace(/<\/p><p>/g, "\n\n")
      .replace(/<\/?p>/g, "")
      .replace(/<br>/g, "\n")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");

  it("is multipart/alternative: the plain text as today, and the same text as HTML", () => {
    expect(mime).toMatch(/^Content-Type: multipart\/alternative; boundary="[^"]+"$/m);
    expect(FakeWriter.bodyOf(raw)).toBe(text);
    const html = FakeWriter.partOf(raw, "text/html");
    expect(html.startsWith('<div dir="auto" style="font-family:inherit"><p>Hi Dana,</p>')).toBe(
      true,
    );
    expect(html).toContain("<p>I can come Monday,<br>Tuesday or Friday.</p>");
    expect(htmlBack(html)).toBe(text);
  });

  it("escapes every character and adds no links, images or colours", () => {
    const html = FakeWriter.partOf(raw, "text/html");
    expect(html).toContain("Prices &lt; $500 &amp; &quot;José&quot; 🙏 it&#39;s fine");
    expect(html).not.toMatch(/<(a|img|span|font|style|script)\b/i);
    expect(html).not.toMatch(/color|href|src=/i);
    expect(textToHtml("<script>alert(1)</script>")).toBe(
      '<div dir="auto" style="font-family:inherit"><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>',
    );
  });

  it("uses a boundary found in neither part, and both parts are base64 UTF-8", () => {
    const boundary = mime.match(/boundary="([^"]+)"/)![1]!;
    const body = mime.slice(mime.indexOf("\r\n\r\n") + 4);
    expect(body.split(`--${boundary}`)).toHaveLength(4); // preamble, 2 parts, closing
    expect(body.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    expect(body.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(2);
    expect(body.match(/charset="UTF-8"/g)).toHaveLength(2);
    expect(mime).toContain("In-Reply-To: <a@b>");
  });

  it("Gmail's parser still reads the plain text, so sameText compares what the owner saw", () => {
    // Our MIME as Gmail's API would hand it back (users.drafts.get, format=full).
    const boundary = mime.match(/boundary="([^"]+)"/)![1]!;
    const body = mime.slice(mime.indexOf("\r\n\r\n") + 4);
    const parts = body
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((chunk) => {
        const at = chunk.indexOf("\r\n\r\n");
        const type = chunk.slice(0, at).match(/Content-Type: ([^;]+)/)![1]!;
        const data = Buffer.from(chunk.slice(at + 4).replace(/\s+/g, ""), "base64").toString(
          "base64url",
        );
        return { mimeType: type, body: { data } };
      });
    const read = extractBodyText({ mimeType: "multipart/alternative", parts });
    expect(sameText(read, text)).toBe(true);
    expect(read).not.toContain("<p>");
  });
});
