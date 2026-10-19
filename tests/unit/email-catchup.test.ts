import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { appSettings, invites, waitlist } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { inviteOwner } from "@/server/admin";
import { catchUpResultText } from "@/server/email-health-rules";
import { GROWTH_ONLY_TEAM_SIZE } from "@/server/growth-note";
import { sendInviteEmail } from "@/server/invite-email";
import { recordTermsAcceptance } from "@/server/terms";
import {
  catchUpWaitlistConfirmations,
  countWaitlistNeverConfirmed,
} from "@/server/waitlist-emails";
import { createTestDb } from "../support/db";

/** Check 18 P4: send an invite email again, and catch up waitlist confirmations that never went out. */

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));
vi.mock("@/auth", () => ({
  auth: async () => (session.user ? { user: { ...session.user, sv: 0 } } : null),
}));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
const { emailInviteAgainAction, catchUpWaitlistEmailsAction } =
  await import("@/app/(app)/admin/actions");

let database: Database;
let sent: OutgoingEmail[];
const ok = async (e: OutgoingEmail) => {
  sent.push(e);
  return "sent" as const;
};
const boom = async () => {
  throw new Error("Resend 403.");
};
const DAY1 = new Date("2026-10-19T14:00:00Z");
const DAY2 = new Date("2026-10-20T14:00:00Z");

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.ADMIN_EMAIL = "davi@example.com";
  database = await createTestDb();
  sent = [];
});
afterEach(() => {
  session.user = null;
  delete process.env.ADMIN_EMAIL;
  vi.restoreAllMocks();
});

describe("Email the sign-in link again", () => {
  it("an invite whose first email failed can be sent again, once a day", async () => {
    await inviteOwner({ email: "mike@shop.com", trade: null, note: null });
    expect(await sendInviteEmail("mike@shop.com", { send: boom })).toBe("failed");
    expect(await sendInviteEmail("mike@shop.com", { send: ok, again: true, now: DAY1 })).toBe(
      "sent",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("mike@shop.com");
    expect(sent[0]!.idempotencyKey).toMatch(/^invite-[0-9a-f]{16}-\d+-again-2026-10-19$/);
    expect(sent[0]!.text).toContain("/signin");
    // A second "again" the same day is skipped; the next day goes.
    expect(await sendInviteEmail("mike@shop.com", { send: ok, again: true, now: DAY1 })).toBe(
      "already_sent",
    );
    expect(sent).toHaveLength(1);
    expect(await sendInviteEmail("mike@shop.com", { send: ok, again: true, now: DAY2 })).toBe(
      "sent",
    );
    expect(sent).toHaveLength(2);
    // The markers carry a salted hash and the day, never the address.
    const keys = (await database.select().from(appSettings)).map((r) => r.key);
    expect(keys.some((k) => /^invite-email-again:[0-9a-f]{16}:2026-10-19$/.test(k))).toBe(true);
    expect(keys.join(" ")).not.toContain("mike@");
    // The ordinary first email still works after an "again" (its own marker).
    expect(await sendInviteEmail("mike@shop.com", { send: ok })).toBe("sent");
  });

  it("a signed-in invite gets no email and the action refuses it; non-admins get a 404", async () => {
    await inviteOwner({ email: "ann@shop.com", trade: null, note: null });
    await database
      .update(invites)
      .set({ acceptedAt: DAY1 })
      .where(eq(invites.email, "ann@shop.com"));
    expect(await sendInviteEmail("ann@shop.com", { send: ok, again: true })).toBe("skipped");
    const form = new FormData();
    form.set("email", "ann@shop.com");
    const { user } = await ensureUserAndWorkspace({ email: "davi@example.com" });
    await recordTermsAcceptance(user.id);
    session.user = { id: user.id, email: "davi@example.com" };
    const where = await emailInviteAgainAction(form).catch((e: unknown) => e);
    expect((where as Redirected).url).toBe("/admin?error=invite_used#invite");

    const owner = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await recordTermsAcceptance(owner.user.id);
    session.user = { id: owner.user.id, email: "owner@shop.com" };
    for (const run of [() => emailInviteAgainAction(form), () => catchUpWaitlistEmailsAction()]) {
      const err = await run().catch((e: unknown) => e);
      expect(String((err as { digest?: string }).digest)).toContain("404");
    }
    expect(sent).toHaveLength(0);
  });
});

describe("Send the list email to people who never got it", () => {
  it("sends only to rows without confirmation_sent_at, skips Growth-only rows, marks each", async () => {
    await database.insert(waitlist).values([
      {
        email: "a@shop.com",
        name: "A",
        teamSize: "Just me",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        email: "b@shop.com",
        name: "B",
        teamSize: "2–5",
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
      { email: "got@shop.com", name: "Got", teamSize: "Just me", confirmationSentAt: DAY1 },
      { email: "growth@shop.com", name: "G", teamSize: GROWTH_ONLY_TEAM_SIZE },
    ]);
    expect(await countWaitlistNeverConfirmed()).toBe(2);
    const r = await catchUpWaitlistConfirmations({ send: ok, pauseMs: 0, now: DAY2 });
    expect(r).toEqual({ sent: 2, failed: 0, left: 0, notConfigured: false });
    expect(sent.map((e) => e.to)).toEqual(["a@shop.com", "b@shop.com"]);
    const rows = await database.select().from(waitlist);
    for (const e of ["a@shop.com", "b@shop.com", "got@shop.com"]) {
      expect(rows.find((x) => x.email === e)!.confirmationSentAt).not.toBeNull();
    }
    expect(rows.find((x) => x.email === "growth@shop.com")!.confirmationSentAt).toBeNull();
    // Nothing goes twice.
    expect(await catchUpWaitlistConfirmations({ send: ok, pauseMs: 0 })).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(2);
  });

  it("one failure is counted and the rest still go; not configured stops it; a tap takes a batch", async () => {
    await database.insert(waitlist).values(
      Array.from({ length: 10 }, (_, i) => ({
        email: `p${i}@shop.com`,
        name: `P${i}`,
        teamSize: "Just me",
        createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
      })),
    );
    let calls = 0;
    const flaky = async (e: OutgoingEmail) => {
      calls++;
      if (e.to === "p1@shop.com") throw new Error("Resend 422.");
      return ok(e);
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await catchUpWaitlistConfirmations({ send: flaky, pauseMs: 0, perTap: 3 });
    expect(r).toEqual({ sent: 2, failed: 1, left: 8, notConfigured: false });
    expect(calls).toBe(3);
    const stop = await catchUpWaitlistConfirmations({
      send: async () => "not_configured" as const,
      pauseMs: 0,
      perTap: 3,
    });
    expect(stop).toMatchObject({ sent: 0, failed: 0, notConfigured: true });
    expect(catchUpResultText("7", "2", "0")).toBe("Sent 7, 2 failed.");
    expect(catchUpResultText("3", "0", "5")).toBe("Sent 3, 0 failed. 5 still to go: tap again.");
    expect(catchUpResultText("x", "2", "0")).toBeUndefined();
  });

  it("Davi's tap redirects with counts only", async () => {
    await database.insert(waitlist).values({ email: "a@shop.com", name: "A", teamSize: "Just me" });
    const { user } = await ensureUserAndWorkspace({ email: "davi@example.com" });
    await recordTermsAcceptance(user.id);
    session.user = { id: user.id, email: "davi@example.com" };
    // No Resend env: the action reports not set up and marks nothing.
    vi.stubEnv("RESEND_API_KEY", "");
    const where = await catchUpWaitlistEmailsAction().catch((e: unknown) => e);
    expect((where as Redirected).url).toBe("/admin?error=email_not_set_up#waitlist");
    expect((await database.select().from(waitlist))[0]!.confirmationSentAt).toBeNull();
    vi.unstubAllEnvs();
  });
});
