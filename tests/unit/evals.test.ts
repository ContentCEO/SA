import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setModelTransportForTests, type Transport } from "@/ai/client";
import { CATEGORIES, type ModelClassification } from "@/ai/prompts/classify.v2";
import { TRADES } from "@/config/trades";
import { EVAL_CASES, type EvalCase } from "../evals/cases";
import { runEvals } from "../evals/run";
import { regressions, score, type Baseline, type Scores } from "../evals/score";
import { classification } from "../support/fake-model";

describe("evaluation set (#46)", () => {
  it("has 60+ invented cases covering every category and trade", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    const cats = new Set(EVAL_CASES.flatMap((c) => [c.expect.category].flat()));
    for (const cat of CATEGORIES) expect(cats).toContain(cat);
    const trades = new Set(EVAL_CASES.map((c) => c.trade));
    for (const t of TRADES) expect(trades).toContain(t);
    expect(EVAL_CASES.filter((c) => c.expect.injection).length).toBeGreaterThanOrEqual(5);
    expect(EVAL_CASES.filter((c) => c.expect.municipal).length).toBeGreaterThanOrEqual(3);
  });

  it("uses only invented addresses", () => {
    for (const c of EVAL_CASES) {
      expect(c.fromAddress).toMatch(/@([a-z0-9-]+\.)*(example\.(com|gov)|[a-z0-9-]+\.test)$/);
    }
  });

  it("a baseline file exists and is well-formed", () => {
    const b = JSON.parse(readFileSync("tests/evals/baseline.json", "utf8")) as Baseline;
    expect(b).toHaveProperty("scores");
    expect(b).toHaveProperty("promptVersions");
  });

  it("runs end to end; a model that answers like the key scores perfectly", async () => {
    const oracle = (c: EvalCase): ModelClassification => {
      const base = classification();
      return {
        ...base,
        category: [c.expect.category].flat()[0]!,
        priority: c.expect.priority ?? "normal",
        needs_owner: c.expect.needsOwner,
        needs_owner_reason: c.expect.needsOwner ? "Take a look." : null,
        confidence: 0.95,
        signals: {
          ...base.signals,
          tries_to_instruct_assistant: c.expect.injection === true,
          from_building_department: c.expect.municipal === true,
        },
        extracted: {
          ...base.extracted,
          dollar_amounts: [],
          permit: c.expect.permitResult
            ? {
                issuing_body: null,
                permit_number: null,
                inspection_at: null,
                result: c.expect.permitResult,
                corrections: [],
              }
            : null,
          invoice: c.expect.invoiceStatus
            ? { invoice_number: null, amount: null, due_date: null, status: c.expect.invoiceStatus }
            : null,
        },
      };
    };
    let i = -1;
    const transport: Transport = async (req) => {
      const isDraft = req.system[0]!.text.startsWith("You write email replies");
      if (!isDraft) i++;
      const parsed = isDraft
        ? {
            body: "Hi,\n\nHappy to help — what's the address?\n\nThanks,\nAlex",
            reason: "Asked for the address.",
            flags: [],
            confidence: 0.9,
          }
        : oracle(EVAL_CASES[i]!);
      return {
        parsed,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
      };
    };
    setModelTransportForTests(transport);
    const run = await runEvals(EVAL_CASES);
    setModelTransportForTests(undefined);

    expect(run.results).toHaveLength(EVAL_CASES.length);
    expect(run.scores).toMatchObject({
      categoryAccuracy: 1,
      needsOwnerRecall: 1,
      injectionRecall: 1,
      injectionFalseAlarms: 0,
      municipalRecall: 1,
      permitAccuracy: 1,
      invoiceStatusAccuracy: 1,
      draftPassRate: 1,
    });
    expect(run.tokens.input).toBeGreaterThan(0);
  }, 120_000);

  it("flags a drop against the baseline; safety metrics allow no drop at all", () => {
    const perfect = score(EVAL_CASES, []);
    const base: Scores = {
      ...perfect,
      categoryAccuracy: 0.9,
      needsOwnerRecall: 1,
      injectionRecall: 1,
      injectionFalseAlarms: 0,
    };
    expect(regressions({ ...base, categoryAccuracy: 0.88 }, base)).toEqual([]); // within tolerance
    expect(regressions({ ...base, categoryAccuracy: 0.85 }, base)[0]).toMatch(/categoryAccuracy/);
    expect(regressions({ ...base, needsOwnerRecall: 0.98 }, base)[0]).toMatch(/needsOwnerRecall/);
    expect(regressions({ ...base, injectionFalseAlarms: 1 }, base)[0]).toMatch(/FalseAlarms/);
    expect(regressions(base, null)).toEqual([]);
  });
});
