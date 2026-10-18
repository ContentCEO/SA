import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { drafts } from "@/db/schema";
import { runAutopilotSend } from "@/server/autopilot";
import { BATCH_CATEGORIES } from "@/server/batch-rules";
import { staleTiming, timingNote } from "@/server/draft-timing";
import { batchSend, deliverQueuedSend, queueSend, sendDraft } from "@/server/drafts";
import { sendPathWorld } from "../support/send-path";

/** Check 43 P7: ask once more before sending an old draft that says "tomorrow". */
describe("Check 43 P7: staleTiming (pure)", () => {
  const NY = "America/New_York";
  const LA = "America/Los_Angeles";

  it("New York: written 11:50pm Friday, read 12:10am Saturday → stale, and 'tomorrow' meant Saturday", () => {
    const written = new Date("2026-10-10T03:50:00Z"); // Fri Oct 9, 11:50pm EDT
    const now = new Date("2026-10-10T04:10:00Z"); // Sat Oct 10, 12:10am EDT
    const t = staleTiming("Tomorrow works, I'll confirm the time.", written, now, NY);
    expect(t).toEqual({ words: ["tomorrow"], writtenOn: "Friday", meant: "Saturday" });
    expect(timingNote(t!)).toBe(
      "Written Friday. It says “tomorrow”, which meant Saturday. Check the timing.",
    );
  });

  it("the same two moments are one day in Los Angeles (8:50pm → 9:10pm): not stale", () => {
    const written = new Date("2026-10-10T03:50:00Z");
    const now = new Date("2026-10-10T04:10:00Z");
    expect(staleTiming("Tomorrow works.", written, now, LA)).toBeNull();
    // …until midnight there.
    expect(staleTiming("Tomorrow works.", written, new Date("2026-10-10T07:05:00Z"), LA)).toEqual({
      words: ["tomorrow"],
      writtenOn: "Friday",
      meant: "Saturday",
    });
  });

  it("across the November DST change, the local day is still what counts", () => {
    // Sat Oct 31 11:30pm EDT (03:30Z Nov 1); clocks fall back at 2am Nov 1.
    const written = new Date("2026-11-01T03:30:00Z");
    // Sun Nov 1, 11:30pm EST (04:30Z Nov 2): 25 hours later, one local day later.
    expect(staleTiming("See you tomorrow", written, new Date("2026-11-02T04:30:00Z"), NY)).toEqual({
      words: ["tomorrow"],
      writtenOn: "Saturday",
      meant: "Sunday",
    });
    // Sun Nov 1, 12:30am EDT→ still Sunday early, the next local day: stale too.
    expect(staleTiming("today", written, new Date("2026-11-01T04:30:00Z"), NY)?.words).toEqual([
      "today",
    ]);
    // 1:30am the first time (05:30Z) and 1:30am again (06:30Z) are the same local day.
    expect(
      staleTiming("today", new Date("2026-11-01T05:30:00Z"), new Date("2026-11-01T06:30:00Z"), NY),
    ).toBeNull();
  });

  it("minute and hour words go stale after two hours, the same day", () => {
    const written = new Date("2026-10-09T14:00:00Z"); // 10am EDT
    const body = "I'll call you in a few minutes.";
    expect(staleTiming(body, written, new Date("2026-10-09T15:30:00Z"), NY)).toBeNull();
    expect(staleTiming(body, written, new Date("2026-10-09T16:30:00Z"), NY)).toEqual({
      words: ["in a few minutes"],
      writtenOn: "at 10:00am",
      meant: null,
    });
    // Day words don't count on the same day.
    expect(staleTiming("Tomorrow at 9.", written, new Date("2026-10-09T22:00:00Z"), NY)).toBeNull();
  });

  it("Spanish and Portuguese words; whole words only; the longer phrase is named once", () => {
    const written = new Date("2026-10-09T14:00:00Z");
    const now = new Date("2026-10-12T14:00:00Z");
    expect(staleTiming("Puedo ir mañana por la tarde.", written, now, NY)?.words).toEqual([
      "mañana",
    ]);
    expect(staleTiming("Posso ir amanhã ou hoje.", written, now, NY)?.words).toEqual([
      "hoje",
      "amanhã",
    ]);
    expect(staleTiming("I'll stop by later today.", written, now, NY)?.words).toEqual([
      "later today",
    ]);
    expect(staleTiming("The todays special; tomorrowland", written, now, NY)).toBeNull();
    expect(staleTiming("Thanks for your patience.", written, now, NY)).toBeNull();
  });
});

describe("Check 43 P7: the send paths ask first", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  const DAY_OLD = new Date("2026-10-09T15:00:00Z"); // the day before NOW, in New York
  const STALE = "Hi Dana,\nTomorrow works, I'll confirm the time.\nThanks, Sam";
  beforeEach(async () => {
    w = await sendPathWorld();
  });

  it("sendDraft: a day-old 'tomorrow' → timing_check with zero Gmail calls; sends once confirmed", async () => {
    const { draft } = await w.seed({ body: STALE, draftCreatedAt: DAY_OLD });
    const r = await sendDraft(w.workspace.id, draft.id, w.deps());
    expect(r).toMatchObject({ status: "timing_check", words: ["tomorrow"], writtenOn: "Friday" });
    expect(w.writer.calls).toEqual([]);
    const ok = await sendDraft(w.workspace.id, draft.id, { ...w.deps(), confirmedTiming: true });
    expect(ok.status).toBe("sent");
    expect(w.writer.sent).toHaveLength(1);
  });

  it("queueSend: refused until confirmed; the queued send then goes without asking again", async () => {
    const { draft } = await w.seed({ body: STALE, draftCreatedAt: DAY_OLD });
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("timing_check");
    expect(w.writer.calls).toEqual([]);
    expect((await w.row(draft.id)).sendAfter).toBeNull();
    const q = await queueSend(w.workspace.id, draft.id, { ...w.deps(), confirmedTiming: true });
    expect(q.status).toBe("queued");
    const at = new Date(w.deps().now().getTime() + 21_000);
    expect(await deliverQueuedSend(draft.id, w.deps(at))).toEqual({ status: "sent" });
    expect(w.writer.sent).toHaveLength(1);
  });

  it("a fresh draft sends exactly as before", async () => {
    const { draft } = await w.seed({ body: STALE });
    expect((await queueSend(w.workspace.id, draft.id, w.deps())).status).toBe("queued");
  });

  it("autopilot refuses: it stands down with the note, nothing sent", async () => {
    const { draft } = await w.seed({ body: STALE, draftCreatedAt: DAY_OLD });
    await w.database
      .update(drafts)
      .set({ autoSendAt: new Date("2026-10-10T15:00:00Z") })
      .where(eq(drafts.id, draft.id));
    const r = await runAutopilotSend(draft.id, w.deps());
    expect(r.status).toBe("stood_down");
    if (r.status === "stood_down")
      expect(r.reasons).toContain(
        "Written Friday. It says “tomorrow”, which meant Saturday. Check the timing.",
      );
    expect(w.writer.sent).toEqual([]);
    // And sendDraft itself never lets autopilot through on one.
    await w.database
      .update(drafts)
      .set({ autoSendAt: new Date("2026-10-10T15:00:00Z"), autoSendClaimedAt: w.deps().now() })
      .where(eq(drafts.id, draft.id));
    expect(
      (await sendDraft(w.workspace.id, draft.id, { ...w.deps(), by: "autopilot" })).status,
    ).toBe("timing_check");
    expect(w.writer.sent).toEqual([]);
  });

  it("batch skips them (counted as refused); the fresh ones go", async () => {
    const stale = await w.seed({ body: STALE, draftCreatedAt: DAY_OLD });
    const fresh = await w.seed();
    const r = await batchSend(
      w.workspace.id,
      [stale.draft.id, fresh.draft.id],
      BATCH_CATEGORIES,
      w.deps(),
    );
    expect(r.queued.map((q) => q.draftId)).toEqual([fresh.draft.id]);
    expect(r.refused).toBe(1);
  });
});
