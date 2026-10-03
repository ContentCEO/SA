import { describe, expect, it } from "vitest";
import { buildReplyMime, encodeHeader, replySubject, sameText, toGmailRaw } from "@/mailbox/mime";
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
