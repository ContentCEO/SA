import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DISPUTE_REASONS } from "@/ai/classify";
import type { Database } from "@/db";
import { activityLog, appSettings, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { M7_BACKFILL_KEY, runM7Backfill } from "@/server/m7-backfill";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { autoSetQuoteOutcome } from "@/server/quotes";
import { createTestDb } from "../support/db";

const NOW = new Date("2026-10-12T15:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
}, 30_000);

async function thread(over: Partial<typeof threads.$inferInsert> = {}) {
  const [t] = await database
    .insert(threads)
    .values({ mailboxId, gmailThreadId: `g${++n}`, category: "customer_question", ...over })
    .returning();
  return t!.id;
}
const rowOf = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!;
const log = (
  threadId: string,
  action: "quote_marked" | "quote_outcome_guessed",
  outcome: string | null,
  at: Date,
) =>
  database.insert(activityLog).values({
    workspaceId,
    threadId,
    actor: action === "quote_marked" ? "owner" : "squared_away",
    action,
    detail: { outcome },
    createdAt: at,
  });

describe("M7 one-shot backfill (run from new code by the 15-minute job)", () => {
  it("marks complaints the old code sorted after the migration: complaint, dispute reason, disputed", async () => {
    const complaint = await thread({ category: "complaint", classifiedAt: ago(5) });
    const reason = await thread({
      category: "invoice_payment",
      needsOwner: true,
      needsOwnerReason: DISPUTE_REASONS[0],
      classifiedAt: ago(4),
    });
    const disputed = await thread({
      category: "invoice_payment",
      extracted: { disputed: true },
      lastMessageAt: ago(3),
    });
    const already = await thread({
      category: "complaint",
      classifiedAt: ago(2),
      complainedAt: ago(100),
    });
    const happy = await thread({ category: "customer_question", classifiedAt: ago(1) });
    const notDisputed = await thread({
      category: "invoice_payment",
      extracted: { disputed: false },
      classifiedAt: ago(1),
    });

    expect(await runM7Backfill(NOW)).toEqual({ ran: true, complaintsMarked: 3, ownerOutcomes: 0 });
    expect((await rowOf(complaint)).complainedAt).toEqual(ago(5));
    expect((await rowOf(reason)).complainedAt).toEqual(ago(4));
    expect((await rowOf(disputed)).complainedAt).toEqual(ago(3));
    // An existing mark is never moved; a happy customer is never marked.
    expect((await rowOf(already)).complainedAt).toEqual(ago(100));
    expect((await rowOf(happy)).complainedAt).toBeNull();
    expect((await rowOf(notDisputed)).complainedAt).toBeNull();
  });

  it("an owner's tap newer than our guess makes the outcome the owner's, so a later guess can't flip it", async () => {
    // We guessed Won; then the owner (on old code) tapped Lost, which left source 'auto'.
    const lostOverGuess = await thread({
      category: "quote_request",
      quoteOutcome: "lost",
      quoteOutcomeSource: "auto",
      quoteOutcomeAt: ago(2),
    });
    await log(lostOverGuess, "quote_outcome_guessed", "won", ago(10));
    await log(lostOverGuess, "quote_marked", "lost", ago(2));
    // The owner (on old code) tapped Reopen over our guess: outcome empty, source left 'auto'.
    const reopened = await thread({ category: "quote_request", quoteOutcomeSource: "auto" });
    await log(reopened, "quote_outcome_guessed", "no_answer", ago(10));
    await log(reopened, "quote_marked", null, ago(1));
    // Won tapped on old code with no source at all.
    const oldWon = await thread({
      category: "quote_request",
      quoteOutcome: "won",
      quoteOutcomeAt: ago(3),
    });
    await log(oldWon, "quote_marked", "won", ago(3));
    // Our guess is the newest thing: stays a guess.
    const guessed = await thread({
      category: "quote_request",
      quoteOutcome: "won",
      quoteOutcomeSource: "auto",
      quoteOutcomeAt: ago(1),
    });
    await log(guessed, "quote_marked", "lost", ago(20));
    await log(guessed, "quote_outcome_guessed", "won", ago(1));
    // Never touched by anyone: left alone.
    const untouched = await thread({ category: "quote_request" });

    expect(await runM7Backfill(NOW)).toEqual({ ran: true, complaintsMarked: 0, ownerOutcomes: 3 });
    expect(await rowOf(lostOverGuess)).toMatchObject({
      quoteOutcome: "lost",
      quoteOutcomeSource: "owner",
    });
    expect(await rowOf(reopened)).toMatchObject({
      quoteOutcome: null,
      quoteOutcomeSource: "owner",
    });
    expect(await rowOf(oldWon)).toMatchObject({ quoteOutcome: "won", quoteOutcomeSource: "owner" });
    expect((await rowOf(guessed)).quoteOutcomeSource).toBe("auto");
    expect((await rowOf(untouched)).quoteOutcomeSource).toBeNull();

    // "Let's do it" later: our guess no longer flips the owner's Lost, or guesses over a Reopen.
    expect(await autoSetQuoteOutcome(lostOverGuess, "won", NOW)).toBe(false);
    expect(await autoSetQuoteOutcome(reopened, "won", NOW)).toBe(false);
    expect((await rowOf(lostOverGuess)).quoteOutcome).toBe("lost");
    // Our own guess can still be revised.
    expect(await autoSetQuoteOutcome(guessed, "lost", NOW)).toBe(true);
  });

  it("runs once: the app_settings key gates it, and a re-run would change nothing anyway", async () => {
    const first = await thread({ category: "complaint", classifiedAt: ago(5) });
    expect(await runM7Backfill(NOW)).toMatchObject({ ran: true, complaintsMarked: 1 });
    const [key] = await database
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, M7_BACKFILL_KEY));
    expect(key?.value).toBe(NOW.toISOString());

    // Gated: a complaint sorted afterwards (new code marks those itself) isn't touched here.
    const later = await thread({ category: "complaint", classifiedAt: ago(1) });
    expect(await runM7Backfill(NOW)).toEqual({ ran: false });
    expect((await rowOf(later)).complainedAt).toBeNull();
    expect((await rowOf(first)).complainedAt).toEqual(ago(5));

    // Idempotent even without the gate: nothing left to do for rows already fixed.
    await database.delete(appSettings).where(eq(appSettings.key, M7_BACKFILL_KEY));
    await database
      .update(threads)
      .set({ complainedAt: ago(1) })
      .where(eq(threads.id, later));
    expect(await runM7Backfill(NOW)).toEqual({ ran: true, complaintsMarked: 0, ownerOutcomes: 0 });
  });

  it("two runs at once mark each row once and leave one key", async () => {
    await thread({ category: "complaint", classifiedAt: ago(5) });
    const results = await Promise.all([runM7Backfill(NOW), runM7Backfill(NOW)]);
    const marked = results.reduce((t, r) => t + (r.ran ? r.complaintsMarked : 0), 0);
    expect(marked).toBe(1);
    expect(
      await database.select().from(appSettings).where(eq(appSettings.key, M7_BACKFILL_KEY)),
    ).toHaveLength(1);
  });

  it("the 15-minute workspace-lifecycle job runs it", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const job = src.slice(src.indexOf("export const workspaceLifecycle"));
    const body = job.slice(0, job.indexOf("\n);"));
    // Check 25 P4: one check inside the grouped "housekeeping" step.
    expect(body).toMatch(/step\.run\("housekeeping"/);
    expect(body).toMatch(/"m7-backfill":\s*\(\)\s*=>\s*runM7Backfill\(\)/);
  });
});
