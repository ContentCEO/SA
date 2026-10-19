import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callStructured,
  requestOptionsFor,
  setEvalModelOverrides,
  setModelTransportForTests,
  type StructuredRequest,
} from "@/ai/client";
import { classificationSchema } from "@/ai/prompts/classify.v4";
import {
  EVAL_MODEL_IDS,
  modelCapabilities,
  modelFallbacks,
  modelLifecycle,
  modelPricing,
  models,
  type ModelId,
} from "@/config/models";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createTestDb } from "../support/db";
import { classification } from "../support/fake-model";
import { EvalArgsError, parseModelArgs } from "../evals/model-args";

/** Check 48 P2: the capability map, not a comment, decides what a request carries. */

const USAGE = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
let workspaceId: string;
let seen: StructuredRequest[];

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "10";
  await createTestDb();
  workspaceId = (await ensureUserAndWorkspace({ email: "o@shop.com" })).workspace.id;
  seen = [];
  setModelTransportForTests(async (r) => {
    seen.push(r);
    return { parsed: classification(), usage: USAGE, stopReason: "end_turn" };
  });
});
afterEach(() => {
  setModelTransportForTests(undefined);
  setEvalModelOverrides(undefined);
});

const call = (role: "classify" | "draft", effort?: "medium") =>
  callStructured({
    workspaceId,
    role,
    promptVersion: "test",
    maxTokens: 10,
    system: [{ text: "x", cache: false }],
    user: "y",
    schema: classificationSchema,
    ...(effort ? { effort } : {}),
  });

describe("modelCapabilities", () => {
  it("covers every model we can call, with a price and a lifecycle row", () => {
    const ids = new Set<ModelId>([
      ...Object.values(models),
      ...Object.values(modelFallbacks).map((f) => f.model),
    ]);
    for (const id of ids) {
      expect(modelCapabilities[id], id).toBeDefined();
      expect(modelPricing[id], id).toBeDefined();
      expect(modelLifecycle[id], id).toBeDefined();
    }
    expect(new Set(EVAL_MODEL_IDS)).toEqual(ids);
  });

  it("sends effort only where the model takes it", () => {
    for (const id of EVAL_MODEL_IDS) {
      const opts = requestOptionsFor(id, "medium");
      expect(opts.effort, id).toBe(modelCapabilities[id].effort ? "medium" : undefined);
      expect(opts.thinking, id).toBe(
        modelCapabilities[id].thinking === "disabled" ? "disabled" : undefined,
      );
    }
    expect(requestOptionsFor(models.draft, undefined).effort).toBeUndefined();
  });

  it("production is unchanged: sorting sends no effort or thinking, drafting keeps its effort", async () => {
    await call("classify", "medium");
    expect(seen[0]!.model).toBe(models.classify);
    expect(seen[0]!.effort).toBe(modelCapabilities[models.classify].effort ? "medium" : undefined);
    expect(seen[0]!.thinking).toBeUndefined();
    await call("draft", "medium");
    expect(seen[1]!.model).toBe(models.draft);
    expect(seen[1]!.effort).toBe("medium");
  });

  it("an eval trial swaps the model for one role and its capabilities come with it", async () => {
    const trial = modelFallbacks.classify.model;
    setEvalModelOverrides({ classify: trial });
    await call("classify", "medium");
    expect(seen[0]!.model).toBe(trial);
    expect(seen[0]!.effort).toBe(modelCapabilities[trial].effort ? "medium" : undefined);
    expect(seen[0]!.thinking).toBe(
      modelCapabilities[trial].thinking === "disabled" ? "disabled" : undefined,
    );
    await call("draft");
    expect(seen[1]!.model).toBe(models.draft);
    setEvalModelOverrides(undefined);
    await call("classify");
    expect(seen[2]!.model).toBe(models.classify);
  });
});

describe("pnpm eval --model", () => {
  const trial = modelFallbacks.classify.model;

  it("reads role=id in both spellings", () => {
    expect(parseModelArgs(["--no-drafts", "--model", `classify=${trial}`])).toEqual({
      classify: trial,
    });
    expect(parseModelArgs([`--model=draft=${models.draft}`])).toEqual({ draft: models.draft });
    expect(parseModelArgs(["--no-drafts"])).toEqual({});
  });

  it("refuses an unknown model, an unknown role and a missing value", () => {
    expect(() => parseModelArgs(["--model", "classify=claude-made-up-1"])).toThrow(EvalArgsError);
    expect(() => parseModelArgs(["--model", `sorting=${trial}`])).toThrow(EvalArgsError);
    expect(() => parseModelArgs(["--model"])).toThrow(EvalArgsError);
    expect(() => parseModelArgs(["--model", trial])).toThrow(EvalArgsError);
  });
});
