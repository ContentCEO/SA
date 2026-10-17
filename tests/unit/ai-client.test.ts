import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyEmail } from "@/ai/classify";
import {
  callStructured,
  isProviderFault,
  parseStructuredText,
  setModelTransportForTests,
  type Transport,
} from "@/ai/client";
import { estimateCostCentiCents } from "@/ai/cost";
import { classificationSchema } from "@/ai/prompts/classify.v4";
import { models } from "@/config/models";
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
afterEach(() => setModelTransportForTests(undefined));

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
