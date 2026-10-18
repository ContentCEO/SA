import { describe, expect, it } from "vitest";
import {
  buildReplyMime,
  encodeHeader,
  formatAddress,
  replySubject,
  sameText,
  toGmailRaw,
} from "@/mailbox/mime";
import { pickFromAddress, pickSenderName } from "@/server/from-line-rules";
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
