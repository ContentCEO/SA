import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { invites, waitlist } from "@/db/schema";
import { lookupMailHost } from "@/server/mail-host";
import {
  domainOf,
  INVITE_NOT_GOOGLE_CONFIRM,
  mailHostFor,
  mailHostLine,
  needsInviteConfirm,
} from "@/server/mail-host-rules";
import { inviteFromWaitlist, joinWaitlist, waitlistInput } from "@/server/waitlist";
import { createTestDb } from "../support/db";

/** Check 47 P3: which waitlist sign-ups aren't on Google, before inviting them. */
describe("mailHostFor (pure)", () => {
  it("public webmail by domain", () => {
    expect(mailHostFor("gmail.com", [])).toBe("google");
    expect(mailHostFor("GoogleMail.com", [])).toBe("google");
    for (const d of ["outlook.com", "hotmail.com", "live.com", "msn.com"]) {
      expect(mailHostFor(d, []), d).toBe("microsoft");
    }
    for (const d of ["yahoo.com", "icloud.com", "aol.com", "proton.me"]) {
      expect(mailHostFor(d, ["mx.google.com"]), d).toBe("other");
    }
  });

  it("a custom domain by its MX hosts; a look-alike never counts as Google", () => {
    expect(
      mailHostFor("ruizplumbing.com", ["aspmx.l.google.com.", "alt1.aspmx.l.google.com"]),
    ).toBe("google");
    expect(mailHostFor("ruizplumbing.com", ["ASPMX.L.GOOGLEMAIL.COM"])).toBe("google");
    expect(mailHostFor("shop.com", ["shop-com.mail.protection.outlook.com"])).toBe("microsoft");
    expect(mailHostFor("shop.com", ["mx1.evilgoogle.com"])).toBe("unknown");
    expect(mailHostFor("shop.com", ["google.com.evil.example"])).toBe("unknown");
    expect(mailHostFor("shop.com", ["mail.outlook.com.example"])).toBe("unknown");
    expect(mailHostFor("shop.com", ["mx.zoho.com"])).toBe("unknown");
    expect(mailHostFor("shop.com", [])).toBe("unknown");
    expect(domainOf("Mike@Ruiz-Plumbing.com")).toBe("ruiz-plumbing.com");
    expect(domainOf("nope")).toBeNull();
  });

  it("the admin line and the confirm rule", () => {
    expect(mailHostLine("google")).toBeNull();
    expect(mailHostLine(null)).toBeNull();
    expect(mailHostLine("microsoft")).toBe("Email on Microsoft (Outlook)");
    expect(mailHostLine("other")).toBe("Email not on Google");
    expect(mailHostLine("unknown")).toBe("Couldn't tell where their email is hosted");
    expect(needsInviteConfirm("google")).toBe(false);
    expect(needsInviteConfirm(null)).toBe(false);
    expect(needsInviteConfirm("microsoft")).toBe(true);
    expect(needsInviteConfirm("other")).toBe(true);
    // DNS didn't answer: the line shows, but a custom domain stays invitable.
    expect(needsInviteConfirm("unknown")).toBe(false);
    expect(INVITE_NOT_GOOGLE_CONFIRM).toContain("Invite anyway?");
  });
});

describe("lookupMailHost", () => {
  it("looks up only the domain, bounded, and any error gives unknown", async () => {
    const asked: string[] = [];
    const google = async (d: string) => {
      asked.push(d);
      return [{ exchange: "aspmx.l.google.com", priority: 1 }];
    };
    expect(await lookupMailHost("Mike@Shop.com", { resolveMx: google })).toBe("google");
    expect(asked).toEqual(["shop.com"]);
    // Webmail needs no DNS.
    expect(await lookupMailHost("a@gmail.com", { resolveMx: google })).toBe("google");
    expect(asked).toHaveLength(1);
    const boom = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await lookupMailHost("a@shop.com", { resolveMx: boom })).toBe("unknown");
    const slow = () => new Promise<{ exchange: string }[]>(() => {});
    expect(await lookupMailHost("a@shop.com", { resolveMx: slow, timeoutMs: 20 })).toBe("unknown");
    expect(await lookupMailHost("not-an-address", { resolveMx: google })).toBe("unknown");
  });
});

describe("waitlist rows carry mail_host", () => {
  let database: Database;
  beforeEach(async () => {
    database = await createTestDb();
  });
  const join = (email: string, resolveMx: (d: string) => Promise<{ exchange: string }[]>) =>
    joinWaitlist(
      waitlistInput.parse({ name: "Mike", email, trade: "plumbing", teamSize: "Just me" }),
      undefined,
      { resolveMx },
    );
  const hostOf = async (email: string) =>
    (await database.select().from(waitlist).where(eq(waitlist.email, email)))[0]!.mailHost;

  it("a resolver that throws saves the row with unknown; the sign-up still goes through", async () => {
    expect(
      await join("mike@shop.com", async () => {
        throw new Error("EAI_AGAIN");
      }),
    ).toBe("joined");
    expect(await hostOf("mike@shop.com")).toBe("unknown");
    expect(await join("ann@outlook.com", async () => [])).toBe("joined");
    expect(await hostOf("ann@outlook.com")).toBe("microsoft");
    expect(
      await join("ws@ruizplumbing.com", async () => [{ exchange: "aspmx.l.google.com" }]),
    ).toBe("joined");
    expect(await hostOf("ws@ruizplumbing.com")).toBe("google");
  });

  it("inviting a Microsoft row needs the confirm field and invites nobody without it", async () => {
    await join("ann@outlook.com", async () => []);
    expect(await inviteFromWaitlist("ann@outlook.com")).toBe("needs_confirm");
    expect(await database.select().from(invites)).toEqual([]);
    expect(await inviteFromWaitlist("ann@outlook.com", new Date(), { confirmed: true })).toBe(
      "invited",
    );
    expect((await database.select().from(invites)).map((i) => i.email)).toEqual([
      "ann@outlook.com",
    ]);
    // A Google row is invited straight away.
    await join("mike@gmail.com", async () => []);
    expect(await inviteFromWaitlist("mike@gmail.com")).toBe("invited");
  });
});
