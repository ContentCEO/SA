import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentLine } from "@/components/app/attachment-line";
import { messages } from "@/db/schema";
import { countAttachments, toMailMessage, type GmailMessagePart } from "@/mailbox/gmail/parse";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { attachmentCardLine, attachmentWords } from "@/server/attachment-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { runBackfill } from "@/server/sync";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";

/** Check 40 P2: how many photos and files came with an email — counts only, never names. */

const text = (t: string): GmailMessagePart => ({
  mimeType: "text/plain",
  body: { data: Buffer.from(t).toString("base64url"), size: t.length },
});
const file = (
  mimeType: string,
  filename: string,
  size: number,
  disposition = "attachment",
): GmailMessagePart => ({
  mimeType,
  filename,
  headers: [{ name: "Content-Disposition", value: `${disposition}; filename="${filename}"` }],
  body: { attachmentId: "att", size },
});

describe("countAttachments", () => {
  it("counts a 3-photo email", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        text("A few shingles blew off over the garage. Photos attached."),
        file("image/jpeg", "IMG_0001.jpg", 2_400_000),
        file("image/jpeg", "IMG_0002.jpg", 2_100_000),
        file("image/heic", "IMG_0003.HEIC", 1_900_000),
      ],
    };
    expect(countAttachments(payload)).toEqual({ images: 3, pdfs: 0, other: 0 });
  });

  it("counts a PDF (and other files) by kind", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        text("Attached is the estimate for claim 26-40118."),
        file("application/pdf", "estimate.pdf", 180_000),
        file("application/octet-stream", "scope.PDF", 90_000),
        file("application/vnd.ms-excel", "line-items.xls", 40_000),
      ],
    };
    expect(countAttachments(payload)).toEqual({ images: 0, pdfs: 2, other: 1 });
  });

  it("a small inline signature logo doesn't count; a big inline photo does", () => {
    const logo: GmailMessagePart = {
      mimeType: "image/png",
      filename: "logo.png",
      headers: [{ name: "Content-ID", value: "<logo@x>" }],
      body: { attachmentId: "a", size: 6_000 },
    };
    const payload: GmailMessagePart = {
      mimeType: "multipart/related",
      parts: [
        { mimeType: "multipart/alternative", parts: [text("Thanks!")] },
        logo,
        file("image/png", "banner.png", 4_000, "inline"),
        file("image/jpeg", "porch.jpg", 900_000, "inline"),
      ],
    };
    expect(countAttachments(payload)).toEqual({ images: 1, pdfs: 0, other: 0 });
  });

  it("a full read carries the counts; a metadata read carries none", () => {
    const resource = {
      id: "m",
      threadId: "t",
      payload: {
        mimeType: "multipart/mixed",
        parts: [text("hi"), file("image/jpeg", "a.jpg", 50_000)],
      },
    };
    expect(toMailMessage(resource, true).attachments).toEqual({ images: 1, pdfs: 0, other: 0 });
    expect(toMailMessage(resource, false).attachments).toBeUndefined();
  });
});

describe("the card line", () => {
  it("says what came, in plain words", () => {
    expect(attachmentWords({ images: 3, pdfs: 1, other: 0 })).toBe("3 photos, 1 PDF");
    expect(attachmentWords({ images: 1, pdfs: 0, other: 2 })).toBe("1 photo, 2 files");
    expect(attachmentCardLine({ images: 3, pdfs: 0, other: 0 })).toBe("3 photos attached");
    expect(attachmentCardLine({ images: 0, pdfs: 0, other: 0 })).toBeNull();
  });

  it('renders "3 photos attached · open in Gmail" with a link to the thread', () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentLine, {
        counts: { images: 3, pdfs: 0, other: 0 },
        gmail: { mailboxEmail: "owner@shop.com", gmailThreadId: "thr1" },
      }),
    );
    expect(html).toContain("3 photos attached");
    expect(html).toContain("open in Gmail");
    expect(html).toContain("https://mail.google.com/mail/?authuser=owner%40shop.com#all/thr1");
    expect(html).toContain("min-h-tap");
    expect(
      renderToStaticMarkup(
        createElement(AttachmentLine, { counts: { images: 0, pdfs: 0, other: 0 }, gmail: null }),
      ),
    ).toBe("");
  });
});

describe("storage", () => {
  it("sync stores the counts of an inbox email, and no file name anywhere", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const m = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: ["x"],
    });
    const fake = new FakeMailbox();
    fake.add({ id: "p", threadId: "t", attachments: { images: 3, pdfs: 1, other: 0 } });
    await runBackfill(m.id, {
      readerFor: () => fake.reader(),
      now: () => new Date("2026-09-28T12:00:00Z"),
    });
    const [row] = await database.select().from(messages);
    expect(row).toMatchObject({ attachmentImages: 3, attachmentPdfs: 1, attachmentOther: 0 });
    // The schema has no place for a file name or attachment content.
    const schema = readFileSync("src/db/schema.ts", "utf8");
    expect(schema).not.toMatch(/filename|file_name|attachment_name|attachment_data/i);
  });
});
