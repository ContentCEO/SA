import { createHash } from "node:crypto";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { invites, rateLimits, waitlist } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { isAllowedToSignIn } from "@/server/accounts";
import {
  growthInput,
  GROWTH_NOTIFY_TIMEOUT_MS,
  growthNotifyKey,
  normalizeUsPhone,
  notifyGrowthRequest,
  requestGrowthCall,
} from "@/server/growth";
import { splitWaitlistNote } from "@/server/growth-note";
import { requestGrowthCallAction } from "@/app/growth-actions";
import { joinWaitlistAction } from "@/app/waitlist-actions";
import { createTestDb } from "../support/db";

let ip = "198.51.100.1";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": ip }),
}));
const sendEmail = vi.fn<(e: OutgoingEmail) => Promise<"sent" | "not_configured">>();
vi.mock("@/lib/email", () => ({ sendEmail: (e: OutgoingEmail) => sendEmail(e) }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

let database: Database;
const ADMIN = "davi-admin@example.com";
beforeEach(async () => {
  database = await createTestDb();
  ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  sendEmail.mockReset();
  sendEmail.mockResolvedValue("sent");
  vi.stubEnv("ADMIN_EMAIL", ADMIN);
  vi.stubEnv("AUTH_SECRET", "test-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const good = {
  name: "Mike Torres",
  phone: "(617) 555-0142",
  email: "Mike@Shop.com",
  trade: "carpentry",
  services: ["google_ads"],
  note: null,
};
const parse = (over: Record<string, unknown> = {}) => growthInput.parse({ ...good, ...over });

const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
};
const goodForm = {
  name: "Mike Torres",
  phone: "617 555 0142",
  email: "mike@shop.com",
  trade: "carpentry",
  services: ["reviews", "google_ads"],
};

describe("Ask Davi to call me: what we accept", () => {
  it("an empty submit explains every required field in plain words, and saves nothing", async () => {
    const r = await requestGrowthCallAction({ status: "idle" }, form({}));
    expect(r.status).toBe("error");
    expect(r.errors?.name?.[0]).toBe("Tell us your name.");
    expect(r.errors?.phone?.[0]).toBe("Tell us a phone number so Davi can call you.");
    expect(r.errors?.email?.[0]).toBe("Tell us your email address.");
    expect(r.errors?.trade?.[0]).toBe("Pick your trade.");
    expect(r.errors?.services?.[0]).toBe("Pick at least one thing you want help with.");
    expect(await database.select().from(waitlist)).toEqual([]);
  });

  it("tidies US phone numbers and refuses ones that can't be real", () => {
    for (const ok of ["(617) 555-0142", "1 617 555 0142", "+1-617-555-0142", "617.555.0142"]) {
      expect(normalizeUsPhone(ok)).toBe("617-555-0142");
      expect(parse({ phone: ok }).phone).toBe("617-555-0142");
    }
    for (const bad of [
      "555-0142",
      "617-555-01422",
      "617-CALL-NOW",
      "000-000-0000",
      "123-456-7890",
      `617-555-0142${" ".repeat(29)}`,
    ]) {
      const r = growthInput.safeParse({ ...good, phone: bad });
      expect(r.success, bad).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.message).toBe(
          "That number doesn't look right. Use a 10-digit number, like 617-555-0142.",
        );
      }
    }
  });

  it("puts services in the page's order, once each, and refuses anything else", () => {
    expect(parse({ services: ["website", "google_ads", "website", "reviews"] }).services).toEqual([
      "google_ads",
      "reviews",
      "website",
    ]);
    const r = growthInput.safeParse({ ...good, services: ["google_ads", "seo"] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Pick from the list.");
  });

  it("names and notes become one line, with no stored-block marker", () => {
    const r = parse({ name: "  Mike\n[Growth call]  T ", note: "Lowell\n\nPhone: 000-000-0000" });
    expect(r.name).toBe("Mike (growth call) T");
    expect(r.note).toBe("Lowell Phone: 000-000-0000");
    expect(parse({ note: "   " }).note).toBeNull();
    expect(
      growthInput.safeParse({ ...good, note: "x".repeat(501) }).error?.issues[0]?.message,
    ).toBe("Keep it under 500 characters.");
    expect(
      growthInput.safeParse({ ...good, name: "x".repeat(121) }).error?.issues[0]?.message,
    ).toBe("That name is too long.");
    expect(growthInput.safeParse({ ...good, email: "mike@" }).error?.issues[0]?.message).toBe(
      "That doesn't look like an email address.",
    );
  });
});

describe("Ask Davi to call me: where it's kept", () => {
  it("a new email gets a Growth-only waitlist row that can't sign in", async () => {
    expect(await requestGrowthCall(parse())).toBe("requested");
    const [row] = await database.select().from(waitlist);
    expect(row).toMatchObject({
      email: "mike@shop.com",
      name: "Mike Torres",
      phone: "617-555-0142",
      trade: "carpentry",
      teamSize: "growth-only",
      invitedAt: null,
    });
    expect(row!.note!.startsWith("[Growth call] ")).toBe(true);
    expect(row!.note).toContain("Help with: Google ads");
    expect(await database.select().from(invites)).toEqual([]);
    expect(await isAllowedToSignIn("mike@shop.com")).toBe(false);
  });

  it("an existing app entry keeps everything it had; blanks are filled; differences are noted", async () => {
    const createdAt = new Date("2026-09-01T12:00:00Z");
    const invitedAt = new Date("2026-09-05T12:00:00Z");
    await database.insert(waitlist).values({
      email: "mike@shop.com",
      name: "Mike",
      teamSize: "2–5",
      note: "Busy in spring",
      createdAt,
      invitedAt,
    });
    expect(await requestGrowthCall(parse())).toBe("added_to_existing");
    const [row] = await database.select().from(waitlist);
    expect(row).toMatchObject({
      name: "Mike",
      teamSize: "2–5",
      createdAt,
      invitedAt,
      // The Growth number lives in the request, never in the app entry's phone column.
      phone: null,
      trade: "carpentry",
    });
    const { appNote, growth } = splitWaitlistNote(row!.note);
    expect(appNote).toBe("Busy in spring");
    expect(growth).toHaveLength(1);
    expect(growth[0]).toMatchObject({ nameGiven: "Mike Torres", tradeGiven: null });

    // The app entry's own phone is kept; a different trade is noted, not overwritten.
    await database.update(waitlist).set({ phone: "978-555-0100" });
    await requestGrowthCall(parse({ name: "MIKE", trade: "roofing", services: ["website"] }));
    const [after] = await database.select().from(waitlist);
    expect(after).toMatchObject({ phone: "978-555-0100", trade: "carpentry", name: "Mike" });
    expect(splitWaitlistNote(after!.note).growth[0]).toMatchObject({
      nameGiven: null,
      tradeGiven: "Roofing",
      phone: "617-555-0142",
    });
    expect(await database.select().from(invites)).toEqual([]);
  });

  it("the same request twice is one row and one block; a new number replaces the old one", async () => {
    await requestGrowthCall(parse(), new Date("2026-10-12T18:05:00Z"));
    const [first] = await database.select().from(waitlist);
    await requestGrowthCall(parse(), new Date("2026-10-12T19:00:00Z"));
    const rows = await database.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe(first!.note);

    await requestGrowthCall(parse({ phone: "978-555-0100" }), new Date("2026-10-13T13:00:00Z"));
    const [row] = await database.select().from(waitlist);
    const { growth } = splitWaitlistNote(row!.note);
    expect(growth).toHaveLength(1);
    expect(growth[0]).toMatchObject({ phone: "978-555-0100", at: "2026-10-13 09:00" });
    expect(row!.phone).toBe("978-555-0100");
    expect(row!.note).not.toContain("617-555-0142");
  });

  it("an app entry with no phone never keeps an older Growth number", async () => {
    await database
      .insert(waitlist)
      .values({ email: "mike@shop.com", name: "Mike", teamSize: "2–5" });
    await requestGrowthCall(parse(), new Date("2026-10-12T18:05:00Z"));
    await requestGrowthCall(parse({ phone: "978-555-0100" }), new Date("2026-10-13T13:00:00Z"));
    const [row] = await database.select().from(waitlist);
    expect(row!.phone).toBeNull();
    const { growth } = splitWaitlistNote(row!.note);
    expect(growth).toHaveLength(1);
    expect(growth[0]!.phone).toBe("978-555-0100");
    expect(row!.note).not.toContain("617-555-0142");
  });

  it("an address longer than email allows is refused in plain words, and nothing is stored", async () => {
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
    expect(long).toHaveLength(255);
    const r = await requestGrowthCallAction({ status: "idle" }, form({ ...goodForm, email: long }));
    expect(r.status).toBe("error");
    expect(r.errors?.email).toEqual(["That doesn't look like an email address."]);
    expect(await database.select().from(waitlist)).toEqual([]);
  });
});

describe("Ask Davi to call me: the form action", () => {
  it("a bot that fills the hidden field is told it worked; nothing is stored, sent or counted", async () => {
    const r = await requestGrowthCallAction(
      { status: "idle" },
      form({ ...goodForm, website: "http://spam.example" }),
    );
    expect(r).toEqual({ status: "requested" });
    expect(await database.select().from(waitlist)).toEqual([]);
    expect(await database.select().from(rateLimits)).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("shares the waitlist's limit: 10 tries an hour from one place across both forms", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await joinWaitlistAction(
        { status: "idle" },
        form({ name: "A", email: `a${i}@x.com`, trade: "plumbing", teamSize: "2–5" }),
      );
      expect(r.status).toBe("joined");
    }
    for (let i = 0; i < 5; i++) {
      const r = await requestGrowthCallAction(
        { status: "idle" },
        form({ ...goodForm, email: `g${i}@x.com` }),
      );
      expect(r.status).toBe("requested");
    }
    const r = await requestGrowthCallAction(
      { status: "idle" },
      form({ ...goodForm, email: "eleventh@x.com" }),
    );
    expect(r.status).toBe("error");
    expect(r.errors?.phone).toEqual([
      "Too many tries from here. Try again in an hour, or call or text 978-201-9763.",
    ]);
    expect(r.values?.email).toBe("eleventh@x.com");
    expect(r.values?.website).toBeUndefined();
    expect(r.services).toEqual(["reviews", "google_ads"]);
    expect(
      await database.select().from(waitlist).where(eq(waitlist.email, "eleventh@x.com")),
    ).toEqual([]);
  });

  it("a good submit is saved, Davi is told, and the tidy number comes back", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await requestGrowthCallAction({ status: "idle" }, form(goodForm));
    expect(r).toEqual({ status: "requested", phone: "617-555-0142" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("growth_call_requested", { existing: false, services: 2 });
    const logged = JSON.stringify(info.mock.calls);
    for (const leak of ["Mike", "617", "mike@shop.com"]) expect(logged).not.toContain(leak);
  });

  it('Check 41 P4: the form\'s "Which trade?" reaches the stored request (integrator fix)', async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await requestGrowthCallAction(
      { status: "idle" },
      form({ ...goodForm, trade: "other", tradeOther: "pest control" }),
    );
    expect(r).toEqual({ status: "requested", phone: "617-555-0142" });
    const [row] = await database.select().from(waitlist).where(eq(waitlist.email, "mike@shop.com"));
    expect(row).toMatchObject({ trade: "other", tradeOther: "pest control" });
  });

  it("if the notice to Davi fails, the request still counts and only the error's name is logged", async () => {
    sendEmail.mockRejectedValue(new TypeError("Resend 500 for mike@shop.com"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await requestGrowthCallAction({ status: "idle" }, form(goodForm));
    expect(r).toEqual({ status: "requested", phone: "617-555-0142" });
    expect(await database.select().from(waitlist)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("growth_notify_failed", { error: "TypeError" });
  });

  it("a notice that never finishes doesn't hold the visitor up past the timeout", async () => {
    sendEmail.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = requestGrowthCallAction({ status: "idle" }, form(goodForm));
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(GROWTH_NOTIFY_TIMEOUT_MS);
      expect(await pending).toEqual({ status: "requested", phone: "617-555-0142" });
    } finally {
      vi.useRealTimers();
    }
    expect(await database.select().from(waitlist)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("growth_notify_failed", { error: "TimeoutError" });
  });

  it("a failed save logs no name, number, email or note, and keeps what they typed with a plain message", async () => {
    // What Drizzle throws when a query fails: every bound value is in the message.
    const leaky = new DrizzleQueryError(
      'insert into "waitlist" ("email", "name", "phone") values ($1, $2, $3)',
      ["mike@shop.com", "Mike Torres", "617-555-0142", "Lowell kitchen"],
      new Error("connection reset"),
    );
    vi.spyOn(database, "transaction").mockRejectedValue(leaky);
    const spies = (["error", "warn", "info", "log"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const r = await requestGrowthCallAction(
      { status: "idle" },
      form({ ...goodForm, note: "Lowell kitchen" }),
    );
    expect(r.status).toBe("error");
    expect(r.errors?.form).toEqual([
      "We couldn't save that just now. Try again in a minute, or call or text 978-201-9763.",
    ]);
    expect(r.values).toMatchObject({ name: "Mike Torres", note: "Lowell kitchen" });
    expect(r.services).toEqual(["reviews", "google_ads"]);
    const out = JSON.stringify(spies.map((s) => s.mock.calls));
    for (const leak of ["Mike", "617-555-0142", "6175550142", "mike@shop.com", "Lowell"]) {
      expect(out).not.toContain(leak);
    }
    expect(spies[0]).toHaveBeenCalledWith("growth_request_failed", { error: "Error" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the notice to Davi", () => {
  it("says only that a request came in: no name, number or email address anywhere", async () => {
    const now = new Date("2026-10-12T18:05:00Z");
    await notifyGrowthRequest("Mike@Shop.com", { send: sendEmail, now });
    const email = sendEmail.mock.calls[0]![0];
    expect(email.to).toBe(ADMIN);
    expect(email.subject).toBe("New Growth call request");
    const all = JSON.stringify({ ...email, to: undefined });
    for (const leak of ["Mike", "mike", "617-555-0142", "Shop.com", "shop.com", "Torres"]) {
      expect(all).not.toContain(leak);
    }
    expect(email.text).toContain("Someone asked for a free Growth call on the website.");
    expect(email.text).toContain("/admin#waitlist");
    expect(email.text).toContain("Names and numbers stay in the admin page, not in this email.");
  });

  it("one notice per person per day, keyed so the address can't be guessed from it", () => {
    const day1 = new Date("2026-10-12T15:00:00Z");
    const key = growthNotifyKey("mike@shop.com", day1);
    expect(key).not.toContain("@");
    expect(growthNotifyKey(" MIKE@shop.com ", new Date("2026-10-12T20:00:00Z"))).toBe(key);
    expect(growthNotifyKey("mike@shop.com", new Date("2026-10-13T15:00:00Z"))).not.toBe(key);
    expect(growthNotifyKey("rosa@plumb.com", day1)).not.toBe(key);
    const plain = createHash("sha256").update("mike@shop.com").digest("hex");
    expect(key).not.toContain(plain.slice(0, 16));
    expect(key).toMatch(/^growth-[0-9a-f]{16}-2026-10-12$/);
  });

  it("is skipped without ADMIN_EMAIL", async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    expect(await notifyGrowthRequest("mike@shop.com", { send: sendEmail })).toBe("skipped");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
