import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { waitlist } from "@/db/schema";
import type { OutgoingEmail, SendOutcome } from "@/lib/email";
import { siteConfig } from "@/config/site";
import { requestGrowthCall, growthInput } from "@/server/growth";
import { waitlistInput, joinWaitlist } from "@/server/waitlist";
import {
  sendWaitlistConfirmation,
  sendWaitlistEmails,
  waitlistConfirmCopy,
  waitlistConfirmKey,
  waitlistNotifyKey,
} from "@/server/waitlist-emails";
import { joinWaitlistAction } from "@/app/waitlist-actions";
import { createTestDb } from "../support/db";

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` }),
}));
const sendEmail = vi.fn<(e: OutgoingEmail) => Promise<SendOutcome>>();
vi.mock("@/lib/email", () => ({ sendEmail: (e: OutgoingEmail) => sendEmail(e) }));
const afterTasks: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => afterTasks.push(task),
}));

const ADMIN = "davi-admin@example.com";
let database: Database;
beforeEach(async () => {
  database = await createTestDb();
  afterTasks.length = 0;
  sendEmail.mockReset();
  sendEmail.mockResolvedValue("sent");
  vi.stubEnv("ADMIN_EMAIL", ADMIN);
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("SUPPORT_EMAIL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const good = {
  name: "Mike Torres",
  email: "Mike@Shop.com",
  trade: "carpentry",
  teamSize: "2–5",
  phone: "617-555-0142",
  note: "Lowell kitchen <b>job</b>",
};
const runAfter = async () => {
  for (const t of afterTasks.splice(0)) await t();
};
const toAdmin = () => sendEmail.mock.calls.map((c) => c[0]).filter((e) => e.to === ADMIN);
const toVisitor = () => sendEmail.mock.calls.map((c) => c[0]).filter((e) => e.to !== ADMIN);

describe("waitlist sign-up emails", () => {
  it("a new sign-up tells Davi and confirms to the person, after the response", async () => {
    let release!: () => void;
    sendEmail.mockImplementation(
      () => new Promise<SendOutcome>((r) => (release = () => r("sent"))),
    );
    expect(await joinWaitlistAction({ status: "idle" }, form(good))).toEqual({ status: "joined" });
    // The action is done before any email has been asked for, let alone settled.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    const running = runAfter();
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2));
    release();
    await running;
    expect(toAdmin()).toHaveLength(1);
    expect(toVisitor()).toHaveLength(1);
    expect(toVisitor()[0]!.to).toBe("mike@shop.com");
  });

  it("Davi's notice is content-free; the confirmation carries nothing the visitor typed", async () => {
    await joinWaitlistAction({ status: "idle" }, form(good));
    await runAfter();
    const [admin] = toAdmin();
    expect(admin!.subject).toBe("New waitlist sign-up");
    expect(admin!.text).toContain("/admin#waitlist");
    const adminAll = JSON.stringify({ ...admin, to: undefined });
    const [mine] = toVisitor();
    const mineAll = JSON.stringify({ ...mine, to: undefined });
    for (const leak of ["Mike", "mike", "Torres", "shop.com", "617-555-0142", "Lowell", "<b>"]) {
      expect(adminAll).not.toContain(leak);
      expect(mineAll).not.toContain(leak);
    }
    expect(mine!.subject).toBe("You're on the Squared Away list");
    expect(mine!.text).toContain(siteConfig.phone);
    expect(mine!.text).toContain("It works with Gmail and Google Workspace today.");
    expect(mine!.replyTo).toBeUndefined();
  });

  it("the confirmation's words take the name from siteConfig, never typed out", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/server/waitlist-emails.ts", "utf8");
    expect(src).not.toMatch(/"[^"\n]*Davi[^"\n]*"|`[^`\n]*Davi[^`\n]*`/);
    expect(src).not.toContain("978");
    expect(waitlistConfirmCopy.lines.join(" ")).toContain(siteConfig.operator.split(" ")[0]!);
    // True statements only: no booking link, no promise of a date.
    expect(JSON.stringify(waitlistConfirmCopy)).not.toMatch(
      /https?:|calendly|book a time|\bwithin\b/i,
    );
  });

  it("replies go to SUPPORT_EMAIL when it is set", async () => {
    vi.stubEnv("SUPPORT_EMAIL", "help@squared.example");
    await joinWaitlist(waitlistInput.parse(good));
    await sendWaitlistConfirmation("mike@shop.com", { send: sendEmail });
    expect(toVisitor()[0]!.replyTo).toBe("help@squared.example");
  });

  it("signing up again sends nothing", async () => {
    await joinWaitlistAction({ status: "idle" }, form(good));
    await runAfter();
    sendEmail.mockClear();
    expect(await joinWaitlistAction({ status: "idle" }, form(good))).toEqual({ status: "joined" });
    expect(afterTasks).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("joining the app list after a Growth request sends once", async () => {
    await requestGrowthCall(
      growthInput.parse({
        name: "Mike Torres",
        phone: "617-555-0142",
        email: "mike@shop.com",
        trade: "carpentry",
        services: ["reviews"],
        note: null,
      }),
    );
    await joinWaitlistAction({ status: "idle" }, form(good));
    await runAfter();
    expect(toVisitor()).toHaveLength(1);
    expect(toAdmin()).toHaveLength(1);
  });

  it("one confirmation per address ever, marked only once Resend took it", async () => {
    await joinWaitlist(waitlistInput.parse(good));
    sendEmail.mockResolvedValueOnce("not_configured");
    expect(await sendWaitlistConfirmation("mike@shop.com", { send: sendEmail })).toBe(
      "not_configured",
    );
    const sentAt = async () =>
      (await database.select().from(waitlist).where(eq(waitlist.email, "mike@shop.com")))[0]!
        .confirmationSentAt;
    expect(await sentAt()).toBeNull();
    sendEmail.mockRejectedValueOnce(new TypeError("Resend 500"));
    await expect(sendWaitlistConfirmation("mike@shop.com", { send: sendEmail })).rejects.toThrow();
    expect(await sentAt()).toBeNull();
    expect(await sendWaitlistConfirmation("mike@shop.com", { send: sendEmail })).toBe("sent");
    expect(await sentAt()).toBeInstanceOf(Date);
    sendEmail.mockClear();
    expect(await sendWaitlistConfirmation("Mike@Shop.com", { send: sendEmail })).toBe(
      "already_sent",
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed or hanging email never fails the sign-up; only the error's name is logged", async () => {
    await joinWaitlist(waitlistInput.parse(good));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendEmail.mockRejectedValue(new TypeError("Resend 500 for mike@shop.com"));
    const r = await sendWaitlistEmails("mike@shop.com", { send: sendEmail });
    expect(r).toEqual({ notify: "failed", confirm: "failed" });
    expect(warn).toHaveBeenCalledWith("waitlist_notify_failed", { error: "TypeError" });
    expect(warn).toHaveBeenCalledWith("waitlist_confirm_failed", { error: "TypeError" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("mike");

    sendEmail.mockImplementation(() => new Promise(() => {}));
    const slow = await sendWaitlistEmails("mike@shop.com", { send: sendEmail, timeoutMs: 5 });
    expect(slow).toEqual({ notify: "failed", confirm: "failed" });
    expect(warn).toHaveBeenCalledWith("waitlist_confirm_failed", { error: "TimeoutError" });
  });

  it("keys hold no address: HMAC-salted, per day for Davi, once ever for the person", () => {
    const day = new Date("2026-10-15T15:00:00Z");
    const plain = createHash("sha256").update("mike@shop.com").digest("hex").slice(0, 16);
    for (const key of [
      waitlistNotifyKey("mike@shop.com", day),
      waitlistConfirmKey("mike@shop.com"),
    ]) {
      expect(key).not.toContain("@");
      expect(key).not.toContain("mike");
      expect(key).not.toContain(plain);
    }
    expect(waitlistNotifyKey("mike@shop.com", day)).toMatch(/^waitlist-[0-9a-f]{16}-2026-10-15$/);
    expect(waitlistConfirmKey(" MIKE@shop.com ")).toBe(waitlistConfirmKey("mike@shop.com"));
    expect(waitlistConfirmKey("mike@shop.com")).toMatch(/^waitlist-confirm-[0-9a-f]{16}$/);
  });

  it("without ADMIN_EMAIL Davi's notice is skipped and the confirmation still goes", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    await joinWaitlist(waitlistInput.parse(good));
    expect(await sendWaitlistEmails("mike@shop.com", { send: sendEmail })).toEqual({
      notify: "skipped",
      confirm: "sent",
    });
  });
});

describe("waitlist save failures", () => {
  it("a redirect thrown inside the save still propagates (framework errors are rethrown)", async () => {
    const { redirect } = await import("next/navigation");
    vi.spyOn(database, "transaction").mockImplementation(() => redirect("/somewhere"));
    const thrown = await joinWaitlistAction({ status: "idle" }, form(good)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as { digest?: string }).digest)).toContain("NEXT_REDIRECT");
  });
});
