import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyEmail } from "@/ai/classify";
import { NonRetriableError } from "inngest";
import {
  callStructured,
  isModelUnavailable,
  isProviderFault,
  ModelUnavailableError,
  parseStructuredText,
  setModelFallbacksForTests,
  setModelTransportForTests,
  type Transport,
} from "@/ai/client";
import { stopIfModelMissing } from "@/jobs/functions";
import type { OutgoingEmail } from "@/lib/email";
import { modelsDownToday, recordModelDown } from "@/server/model-alerts";
import { modelDownEmail, modelDownLine, stoppedHeading } from "@/server/model-alert-rules";
import { estimateCostCentiCents } from "@/ai/cost";
import { classificationSchema } from "@/ai/prompts/classify.v4";
import { modelFallbacks, models } from "@/config/models";
import type { Database } from "@/db";
import { usage } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createTestDb } from "../support/db";
import { classification } from "../support/fake-model";

const NOW = new Date("2026-10-17T12:00:00Z");
const USAGE = { inputTokens: 1500, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 };

let database: Database;
let workspaceId: string;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "10";
  database = await createTestDb();
  workspaceId = (await ensureUserAndWorkspace({ email: "o@shop.com" })).workspace.id;
});
afterEach(() => {
  setModelTransportForTests(undefined);
  setModelFallbacksForTests(undefined);
});

const req = () => ({
  workspaceId,
  role: "classify" as const,
  promptVersion: "classify.v4",
  maxTokens: 10,
  system: [{ text: "x", cache: false }],
  user: "y",
  schema: classificationSchema,
  now: NOW,
});
const row = async () =>
  (await database.select().from(usage).where(eq(usage.workspaceId, workspaceId)))[0];

describe("a broken AI answer is counted, costed and retried (Check 29 P1)", () => {
  it("our own parser: truncated or off-schema JSON is null, a good answer is the data", () => {
    const good = JSON.stringify(classification());
    expect(parseStructuredText(good, classificationSchema)).toMatchObject({
      category: "quote_request",
    });
    expect(parseStructuredText(good.slice(0, 40), classificationSchema)).toBeNull();
    expect(parseStructuredText('{"category":"nope"}', classificationSchema)).toBeNull();
    expect(parseStructuredText(null, classificationSchema)).toBeNull();
  });

  it("a null answer records its tokens and cost and keeps the call counted", async () => {
    setModelTransportForTests(async () => ({ parsed: null, usage: USAGE, stopReason: "end_turn" }));
    expect(await callStructured(req())).toBeNull();
    const r = await row();
    expect(r!.aiCalls).toBe(1);
    expect(r!.modelTokensIn).toBe(1500);
    expect(r!.modelTokensOut).toBe(900);
    expect(r!.estimatedCostCentiCents).toBe(estimateCostCentiCents(models.classify, USAGE));
    expect(r!.estimatedCostCentiCents).toBeGreaterThan(0);
  });

  it("cut off at max_tokens: classifyEmail retries once, then says unreadable; both calls billed", async () => {
    let n = 0;
    setModelTransportForTests(async () => {
      n++;
      return { parsed: null, usage: USAGE, stopReason: "max_tokens" };
    });
    const logs: unknown[][] = [];
    const orig = console.info;
    console.info = (...a: unknown[]) => void logs.push(a);
    let result;
    try {
      result = await classifyEmail(
        workspaceId,
        {
          businessName: "Elm Electric",
          trade: "electrical",
          amountThresholdDollars: 2500,
          vipSenders: [],
        },
        {
          fromName: "Dana",
          fromAddress: "dana@x.com",
          subject: "Panel upgrade",
          receivedAt: NOW,
          firstTimeSender: false,
          threadSummary: null,
          body: "SECRET-BODY can you quote a panel?",
        },
        { senderIsVip: false, now: NOW },
      );
    } finally {
      console.info = orig;
    }
    expect(n).toBe(2);
    expect(result.unreadable).toBe(true);
    const r = await row();
    expect(r!.aiCalls).toBe(2);
    expect(r!.estimatedCostCentiCents).toBe(2 * estimateCostCentiCents(models.classify, USAGE));
    // The stop reason is in the content-free ai_call line.
    const calls = logs.filter((l) => l[0] === "ai_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toMatchObject({ stopReason: "max_tokens", valid: false });
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });

  it("provider faults are refunded; our own errors are not", async () => {
    const throwing =
      (err: unknown): Transport =>
      async () => {
        throw err;
      };
    const quiet = console.error;
    console.error = () => {};
    try {
      setModelTransportForTests(
        throwing(new Anthropic.APIError(529, undefined, "overloaded", undefined)),
      );
      await expect(callStructured(req())).rejects.toBeInstanceOf(Anthropic.APIError);
      expect((await row())!.aiCalls).toBe(0);
      setModelTransportForTests(throwing(new Anthropic.APIConnectionError({ message: "x" })));
      await expect(callStructured(req())).rejects.toBeInstanceOf(Anthropic.APIConnectionError);
      expect((await row())!.aiCalls).toBe(0);

      setModelTransportForTests(throwing(new Error("our bug")));
      await expect(callStructured(req())).rejects.toThrow("our bug");
      expect((await row())!.aiCalls).toBe(1);
    } finally {
      console.error = quiet;
    }
    expect(isProviderFault(new Anthropic.APIConnectionTimeoutError())).toBe(true);
    expect(isProviderFault(new Anthropic.APIError(429, undefined, "slow", undefined))).toBe(true);
    expect(isProviderFault(new Anthropic.APIError(400, undefined, "bad", undefined))).toBe(false);
    expect(isProviderFault(new TypeError("x"))).toBe(false);
  });
});

describe("a missing or overloaded model (Check 48 P3)", () => {
  const notFound = () =>
    new Anthropic.NotFoundError(404, undefined, "model: x not found", new Headers());
  const overloaded = () => new Anthropic.APIError(529, undefined, "Overloaded", undefined);
  const approved = {
    classify: { model: modelFallbacks.classify.model, fallbackApproved: true },
    draft: { model: modelFallbacks.draft.model, fallbackApproved: true },
    voice: { model: modelFallbacks.voice.model, fallbackApproved: true },
  };
  let quiet: typeof console.error;
  beforeEach(() => {
    quiet = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = quiet;
  });

  it("a 404 is refunded, thrown as ModelUnavailableError, never retried, and shows on /admin", async () => {
    const seen: string[] = [];
    setModelTransportForTests(async (r) => {
      seen.push(r.model);
      throw notFound();
    });
    const err = await callStructured(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).model).toBe(models.classify);
    expect(seen).toEqual([models.classify]);
    expect((await row())!.aiCalls).toBe(0);
    expect((await modelsDownToday(NOW)).map((m) => [m.role, m.model])).toEqual([
      ["classify", models.classify],
    ]);
    expect(await modelsDownToday(new Date(NOW.getTime() + 86_400_000))).toEqual([]);
  });

  it("a 400 that says the model isn't available counts as missing; other 400s don't", () => {
    const bad = (m: string) => new Anthropic.BadRequestError(400, undefined, m, new Headers());
    expect(isModelUnavailable(bad("model: claude-x is not available"))).toBe(true);
    expect(isModelUnavailable(bad("max_tokens: too large"))).toBe(false);
    expect(isModelUnavailable(notFound())).toBe(true);
  });

  it("a 529 with the stand-in approved: one call on the stand-in, recorded in usage", async () => {
    setModelFallbacksForTests(approved);
    const seen: string[] = [];
    setModelTransportForTests(async (r) => {
      seen.push(r.model);
      if (r.model === models.classify) throw overloaded();
      return { parsed: classification(), usage: USAGE, stopReason: "end_turn" };
    });
    const logs: unknown[][] = [];
    const info = console.info;
    console.info = (...a: unknown[]) => void logs.push(a);
    try {
      expect(await callStructured(req())).toMatchObject({ category: "quote_request" });
    } finally {
      console.info = info;
    }
    expect(seen).toEqual([models.classify, modelFallbacks.classify.model]);
    const r = await row();
    expect(r).toMatchObject({ aiCalls: 1, fallbackCalls: 1 });
    expect(r!.estimatedCostCentiCents).toBe(
      estimateCostCentiCents(modelFallbacks.classify.model, USAGE),
    );
    expect(logs.find((l) => l[0] === "ai_call")![1]).toMatchObject({ fallbackUsed: true });
  });

  it("at most one stand-in try per call; a missing stand-in is refunded too", async () => {
    setModelFallbacksForTests(approved);
    const seen: string[] = [];
    setModelTransportForTests(async (r) => {
      seen.push(r.model);
      throw notFound();
    });
    await expect(callStructured(req())).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(seen).toEqual([models.classify, modelFallbacks.classify.model]);
    expect((await row())!.aiCalls).toBe(0);
  });

  it("not approved (as shipped): no stand-in", async () => {
    expect(Object.values(modelFallbacks).every((f) => !f.fallbackApproved)).toBe(true);
    const seen: string[] = [];
    setModelTransportForTests(async (r) => {
      seen.push(r.model);
      throw overloaded();
    });
    await expect(callStructured(req())).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(seen).toEqual([models.classify]);
    expect((await row())!.aiCalls).toBe(0);
    expect((await row())!.fallbackCalls).toBe(0);
  });

  it("Davi gets one content-free email per model per UTC day", async () => {
    process.env.ADMIN_EMAIL = "davi@example.com";
    process.env.APP_URL = "https://app.example";
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail) => {
      sent.push(e);
      return "sent" as const;
    };
    try {
      await recordModelDown("classify", "claude-x", NOW, { send });
      await recordModelDown("classify", "claude-x", new Date(NOW.getTime() + 3_600_000), { send });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("davi@example.com");
      expect(sent[0]!.text).toContain("Sorting is stopped: claude-x is not available.");
      await recordModelDown("classify", "claude-x", new Date(NOW.getTime() + 86_400_000), { send });
      expect(sent).toHaveLength(2);
      // A refused email is tried again on the next failure, and never throws.
      await recordModelDown("classify", "claude-y", NOW, {
        send: async () => {
          throw new Error("Resend 403.");
        },
      });
      await recordModelDown("classify", "claude-y", NOW, { send });
      expect(sent).toHaveLength(3);
    } finally {
      delete process.env.ADMIN_EMAIL;
    }
  });

  it("the email and /admin name the part that stopped: sorting, drafting or voice learning", async () => {
    process.env.ADMIN_EMAIL = "davi@example.com";
    process.env.APP_URL = "https://app.example";
    const sent: OutgoingEmail[] = [];
    const send = async (e: OutgoingEmail) => {
      sent.push(e);
      return "sent" as const;
    };
    try {
      // Drafting and voice learning share one model: each part gets its own email and line.
      await recordModelDown("draft", models.draft, NOW, { send });
      await recordModelDown("voice", models.voice, new Date(NOW.getTime() + 60_000), { send });
      await recordModelDown("draft", models.draft, new Date(NOW.getTime() + 120_000), { send });
      expect(sent.map((e) => e.subject)).toEqual([
        `Drafting is stopped: ${models.draft} is not available`,
        `Voice learning is stopped: ${models.voice} is not available`,
      ]);
      expect(sent[0]!.text).toContain(`Drafting is stopped: ${models.draft} is not available.`);
      expect(sent[0]!.text).not.toContain("Sorting");
      expect(sent[1]!.text).toContain(`Voice learning is stopped: ${models.voice}`);
      const down = await modelsDownToday(NOW);
      expect(down.map((m) => m.role)).toEqual(["draft", "voice"]);
      expect(stoppedHeading(down.map((m) => m.role))).toBe(
        "Drafting and voice learning are stopped",
      );
      expect(modelDownLine("draft", models.draft, "9:00 AM")).toBe(
        `Drafting stopped since 9:00 AM: model not available (${models.draft}).`,
      );
    } finally {
      delete process.env.ADMIN_EMAIL;
    }
    expect(stoppedHeading(["classify"])).toBe("Sorting is stopped");
    expect(stoppedHeading(["draft"])).toBe("Drafting is stopped");
    expect(stoppedHeading(["voice"])).toBe("Voice learning is stopped");
    expect(modelDownEmail("classify", "claude-x").subject).toBe(
      "Sorting is stopped: claude-x is not available",
    );
  });

  it("a missing drafting model is recorded under drafting, not sorting", async () => {
    setModelTransportForTests(async () => {
      throw notFound();
    });
    await callStructured({ ...req(), role: "draft" }).catch(() => undefined);
    expect((await modelsDownToday(NOW)).map((m) => [m.role, m.model])).toEqual([
      ["draft", models.draft],
    ]);
  });

  it("jobs turn it into NonRetriableError; other errors pass through", async () => {
    await expect(
      stopIfModelMissing(async () => {
        throw new ModelUnavailableError("classify", "claude-x");
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    await expect(
      stopIfModelMissing(async () => {
        throw new Error("other");
      }),
    ).rejects.toThrow("other");
    await expect(stopIfModelMissing(async () => 3)).resolves.toBe(3);
  });
});
