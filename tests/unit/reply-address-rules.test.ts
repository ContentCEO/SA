import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  customerReplyAddress,
  customerReplyName,
  pickReplyTo,
  replyRedirected,
  type ReplyToHeader,
  looksLikeFormSender,
} from "@/server/reply-address-rules";
import { replyAddressSql, replyNameSql } from "@/server/thread-sql";
import { createTestDb } from "../support/db";

/**
 * Review "Must fix" (B1): website contact forms email the owner from a robot address and put
 * the customer in Reply-To. These are the layouts real form builders and job software send
 * (addresses invented, shapes as they arrive).
 */
const SELF = ["mike@ruizplumbing.com"];
const pick = (replyTo: string | undefined, from: string, self = SELF) =>
  pickReplyTo(replyTo, { from, self });

describe("pickReplyTo: real form layouts", () => {
  it("Squarespace: robot From, customer in Reply-To", () => {
    expect(pick("Dana Ruiz <dana.ruiz@gmail.com>", "form-submission@squarespace.info")).toEqual({
      address: "dana.ruiz@gmail.com",
      name: "Dana Ruiz",
    });
  });

  it("Wix: a no-reply robot, customer in Reply-To", () => {
    expect(pick("dana.ruiz@gmail.com", "no-reply@crm.wix.com")).toEqual({
      address: "dana.ruiz@gmail.com",
    });
  });

  it("WordPress Contact Form 7: sent from the owner's own domain, customer in Reply-To", () => {
    // From: Dana Ruiz <wordpress@ruizplumbing.com> — the shop's own domain, not this mailbox.
    expect(pick("dana@gmail.com", "wordpress@ruizplumbing.com")).toEqual({
      address: "dana@gmail.com",
    });
  });

  it('WPForms: a quoted "Last, First" name with a comma', () => {
    expect(pick('"Ruiz, Dana" <dana@example.net>', "wordpress@ruizplumbing.com")).toEqual({
      address: "dana@example.net",
      name: "Ruiz, Dana",
    });
  });

  it("Jobber and Housecall Pro request forms", () => {
    expect(pick("Dana Ruiz <dana@example.net>", "notifications@getjobber.com")).toEqual({
      address: "dana@example.net",
      name: "Dana Ruiz",
    });
    expect(pick("<dana@example.net>", "no-reply@housecallpro.com")).toEqual({
      address: "dana@example.net",
    });
  });

  it("Thumbtack / Angi relays stay platform leads (answered on the platform, as before)", () => {
    expect(pick("reply+8x2k@messages.thumbtack.com", "noreply@thumbtack.com")).toEqual({});
    expect(pick("lead-4411@reply.angi.com", "noreply@angi.com")).toEqual({});
    expect(pick("pro-replies@homeadvisor.com", "leads@homeadvisor.com")).toEqual({});
    // Angi-style with no Reply-To at all.
    expect(pick(undefined, "noreply@angi.com")).toEqual({});
  });
});

describe("pickReplyTo: edge cases", () => {
  it("nothing to redirect", () => {
    expect(pick("dana@x.com", "dana@x.com")).toEqual({});
    expect(pick("DANA@X.COM", "dana@x.com")).toEqual({});
    expect(pick("", "dana@x.com")).toEqual({});
    expect(pick(undefined, "dana@x.com")).toEqual({});
  });

  it("never the shop itself: this mailbox, another mailbox of the workspace, its domain", () => {
    expect(pick("mike@ruizplumbing.com", "no-reply@crm.wix.com")).toEqual({});
    expect(
      pick("office.ruiz@gmail.com", "no-reply@crm.wix.com", [...SELF, "office.ruiz@gmail.com"]),
    ).toEqual({});
    expect(pick("estimates@ruizplumbing.com", "no-reply@crm.wix.com")).toEqual({});
    // A shop on public webmail: another gmail.com address is a stranger, so it's fine.
    expect(pick("dana@gmail.com", "no-reply@crm.wix.com", ["ruiz.plumbing@gmail.com"])).toEqual({
      address: "dana@gmail.com",
    });
  });

  it("a no-reply Reply-To falls back to From", () => {
    expect(pick("noreply@forms.example.com", "dana@x.com")).toEqual({});
    expect(pick("do-not-reply@example.com", "form@squarespace.info")).toEqual({});
  });

  it("several addresses: the first usable one", () => {
    expect(pick("noreply@x.com, Dana <dana@y.com>, b@z.com", "form@squarespace.info")).toEqual({
      address: "dana@y.com",
      name: "Dana",
    });
  });

  it("malformed, spaces, no @, too long, control characters", () => {
    expect(pick("not an address", "form@squarespace.info")).toEqual({});
    expect(pick("dana at gmail.com", "form@squarespace.info")).toEqual({});
    expect(pick("dana@", "form@squarespace.info")).toEqual({});
    expect(pick("a@b@c.com", "form@squarespace.info")).toEqual({});
    expect(pick(`${"a".repeat(250)}@x.com`, "form@squarespace.info")).toEqual({});
    expect(pick("dana@x.com\r\nBcc: evil@y.com", "form@squarespace.info")).toEqual({});
    expect(pick("dana@x.com\nBcc: evil@y.com", "form@squarespace.info")).toEqual({});
  });

  it("names are cleaned and bounded; RFC 2047 names are left as given", () => {
    expect(pick('"  Dana   Ruiz " <dana@x.com>', "form@squarespace.info").name).toBe("Dana Ruiz");
    expect(pick(`"${"x".repeat(300)}" <dana@x.com>`, "form@squarespace.info").name).toHaveLength(
      120,
    );
    expect(pick("=?UTF-8?Q?Dana_R=C3=BAiz?= <dana@x.com>", "form@squarespace.info").name).toBe(
      "=?UTF-8?Q?Dana_R=C3=BAiz?=",
    );
  });
});

describe("customerReplyAddress / Name", () => {
  const form = {
    fromAddress: "no-reply@crm.wix.com",
    fromName: "Wix Forms",
    replyToHeader: { address: "dana@x.com" } as ReplyToHeader,
  };
  it("a form's Reply-To wins, and the robot's name never shows", () => {
    expect(customerReplyAddress(form)).toBe("dana@x.com");
    expect(customerReplyName(form)).toBeNull();
    expect(replyRedirected(form)).toBe(true);
    expect(
      customerReplyName({ ...form, replyToHeader: { address: "d@x.com", name: "Dana" } }),
    ).toBe("Dana");
  });
  it("read with nothing usable, or never read: the sender", () => {
    for (const replyToHeader of [{}, null]) {
      const m = { fromAddress: " Dana@X.com ", fromName: "Dana", replyToHeader };
      expect(customerReplyAddress(m)).toBe("dana@x.com");
      expect(customerReplyName(m)).toBe("Dana");
      expect(replyRedirected(m)).toBe(false);
    }
    expect(customerReplyAddress({ fromAddress: null, replyToHeader: null })).toBeNull();
  });
});

describe("the SQL twin matches the TS rule", () => {
  it("on every kind of row", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "mike@ruizplumbing.com" });
    const mb = await saveConnectedMailbox(workspace, {
      email: "mike@ruizplumbing.com",
      refreshToken: "rt",
      grantedScopes: ["x"],
    });
    const [t] = await database
      .insert(threads)
      .values({ mailboxId: mb.id, gmailThreadId: "t" })
      .returning();
    const fixtures: {
      fromAddress: string | null;
      fromName: string | null;
      h: ReplyToHeader | null;
    }[] = [
      { fromAddress: "no-reply@crm.wix.com", fromName: "Wix Forms", h: { address: "dana@x.com" } },
      {
        fromAddress: "form-submission@squarespace.info",
        fromName: "Squarespace",
        h: { address: "dana@y.com", name: "Dana Ruiz" },
      },
      { fromAddress: "Sam@Z.com", fromName: "Sam", h: {} },
      { fromAddress: "kim@z.com", fromName: null, h: null },
      { fromAddress: null, fromName: null, h: null },
    ];
    for (const [i, f] of fixtures.entries()) {
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: mb.id,
        gmailMessageId: `m${i}`,
        fromAddress: f.fromAddress,
        fromName: f.fromName,
        replyToHeader: f.h,
        direction: "in",
        sentAt: new Date(`2026-10-0${i + 1}T12:00:00Z`),
      });
    }
    type Row = { g: string; a: string | null; n: string | null };
    const result = await database.execute(
      sql`select m.gmail_message_id as g, ${replyAddressSql("m")} as a, ${replyNameSql("m")} as n from messages m order by m.gmail_message_id`,
    );
    const rows = (result as unknown as { rows: Row[] }).rows;
    for (const [i, f] of fixtures.entries()) {
      const row = rows.find((r) => r.g === `m${i}`)!;
      const m = { fromAddress: f.fromAddress, fromName: f.fromName, replyToHeader: f.h };
      expect(row.a).toBe(customerReplyAddress(m));
      expect(row.n).toBe(customerReplyName(m));
    }
  }, 30_000);
});

describe("looksLikeFormSender (how firmly a past send is worded)", () => {
  it("form robots", () => {
    for (const a of [
      "form-submission@squarespace.info",
      "no-reply@crm.wix.com",
      "wordpress@ruizplumbing.com",
      "forms@getjobber.com",
      "noreply@housecallpro.com",
    ])
      expect(looksLikeFormSender(a), a).toBe(true);
  });
  it("people", () => {
    for (const a of ["dana@gmail.com", "office@pm-co.com", "formanj@gmail.com", "", null])
      expect(looksLikeFormSender(a), String(a)).toBe(false);
  });
});
