import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { editorGapsLeft, fromEditorText, hasUnfilledGap, toEditorText } from "@/ai/gaps";
import { activityLog } from "@/db/schema";
import { MailboxRateLimitError } from "@/mailbox/connector";
import { discardDraft, queueSend, reviseDraft, saveDraftEdit } from "@/server/drafts";
import { fakeTransport } from "../support/fake-model";
import { sendPathWorld } from "../support/send-path";

/**
 * Check 9 P3: a Gmail hiccup on a queue button is a plain notice ("nothing was sent"), never
 * the crash page. Check 9 P4: gaps read as words in the Edit box and come back as tokens.
 */
describe("Check 9 P3: Gmail hiccups on the queue's buttons", () => {
  let w: Awaited<ReturnType<typeof sendPathWorld>>;
  beforeEach(async () => {
    process.env.AI_DAILY_CALL_CAP = "100";
    w = await sendPathWorld();
  });
  const failGetDraft = (err: Error) => {
    w.writer.getDraft = async () => {
      w.writer.calls.push("getDraft");
      throw err;
    };
  };

  it("queueSend: Gmail rate limit → gmail_busy, nothing queued or logged", async () => {
    const { draft } = await w.seed();
    failGetDraft(new MailboxRateLimitError("slow down"));
    expect(await queueSend(w.workspace.id, draft.id, w.deps())).toEqual({ status: "gmail_busy" });
    const after = await w.row(draft.id);
    expect(after.sendAfter).toBeNull();
    expect(after.status).toBe("pending");
    expect(w.writer.sent).toEqual([]);
    expect(
      await w.database.select().from(activityLog).where(eq(activityLog.action, "send_approved")),
    ).toEqual([]);
  });

  it("queueSend: any other Gmail failure → gmail_failed, nothing queued", async () => {
    const { draft } = await w.seed();
    failGetDraft(new Error("Gmail 503"));
    expect(await queueSend(w.workspace.id, draft.id, w.deps())).toEqual({
      status: "gmail_failed",
    });
    expect((await w.row(draft.id)).sendAfter).toBeNull();
    expect(w.writer.sent).toEqual([]);
  });

  it("saveDraftEdit, reviseDraft and discardDraft answer the same way and change nothing", async () => {
    const { draft } = await w.seed();
    failGetDraft(new MailboxRateLimitError("slow down"));
    expect(await saveDraftEdit(w.workspace.id, draft.id, "New words.", w.deps())).toBe(
      "gmail_busy",
    );
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    expect(await reviseDraft(w.workspace.id, draft.id, { tweak: "shorter" }, w.deps())).toEqual({
      status: "gmail_busy",
    });
    expect(calls).toHaveLength(0);
    w.writer.deleteDraft = async () => {
      throw new Error("Gmail 500");
    };
    expect(await discardDraft(w.workspace.id, draft.id, w.deps())).toBe("gmail_failed");
    const after = await w.row(draft.id);
    expect(after.status).toBe("pending");
    expect(after.body).toBe(draft.body);
  });
});

describe("Check 9 P4: gaps in the Edit box", () => {
  const body =
    "Hi Dana,\nIt's {{price}} and I can come {{date}} at {{ time }}.\n{{custom:job address}}?";

  it("read as words and come back as tokens (round trip)", () => {
    const shown = toEditorText(body);
    expect(shown).toBe("Hi Dana,\nIt's [price] and I can come [date] at [time].\n[job address]?");
    expect(fromEditorText(shown, body)).toBe(
      "Hi Dana,\nIt's {{price}} and I can come {{date}} at {{time}}.\n{{custom:job address}}?",
    );
    // The server still refuses what's left unfilled.
    expect(hasUnfilledGap(fromEditorText(shown, body))).toBe(true);
  });

  it("filled words stay as typed; only the gaps left are named", () => {
    const shown = toEditorText(body)
      .replace("[price]", "$450")
      .replace("[date]", "Tuesday")
      .replace("[job address]", "12 Elm St");
    expect(editorGapsLeft(shown, body)).toEqual(["[time]"]);
    const back = fromEditorText(shown.replace("[time]", "9am"), body);
    expect(back).toBe("Hi Dana,\nIt's $450 and I can come Tuesday at 9am.\n12 Elm St?");
    expect(hasUnfilledGap(back)).toBe(false);
  });

  it("a body with no gaps passes through untouched", () => {
    const plain = "Hi Dana, [see attached] thanks.";
    expect(toEditorText(plain)).toBe(plain);
    expect(fromEditorText(plain, plain)).toBe(plain);
  });
});
