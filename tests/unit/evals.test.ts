import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setModelTransportForTests, type Transport } from "@/ai/client";
import { CATEGORIES, type ModelClassification } from "@/ai/prompts/classify.v5";
import { TRADES } from "@/config/trades";
import { EVAL_CASES, type EvalCase } from "../evals/cases";
import { OPENING_TWEAKS } from "@/ai/prompts/opening-tweaks.v1";
import { REVISE_CASES, TONE_CASES } from "../evals/edits";
import { PURPOSE_CASES } from "../evals/purposes";
import { runEvals } from "../evals/run";
import { regressions, score, type Baseline, type EvalResult, type Scores } from "../evals/score";
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

  it("covers the classify.v3 signals both ways", () => {
    const n = (f: (c: EvalCase) => boolean) => EVAL_CASES.filter(f).length;
    expect(n((c) => c.expect.acceptsQuote === true)).toBeGreaterThanOrEqual(5);
    expect(n((c) => c.expect.acceptsQuote === false)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.jobDone === true)).toBeGreaterThanOrEqual(4);
    expect(n((c) => c.expect.jobDone === false)).toBeGreaterThanOrEqual(2);
    // An acceptance needs the earlier quote as context, or the model can't tell.
    for (const c of EVAL_CASES.filter((x) => x.expect.acceptsQuote === true)) {
      expect(c.threadSummary, c.id).toBeTruthy();
    }
  });

  it("scores the signals only where the key says so", () => {
    const result = (c: EvalCase, over: Partial<EvalResult>): EvalResult => ({
      id: c.id,
      category: [c.expect.category].flat()[0]!,
      needsOwner: c.expect.needsOwner,
      priority: "normal",
      injection: false,
      municipal: false,
      permitResult: null,
      invoiceStatus: null,
      acceptsQuote: false,
      jobDone: false,
      paymentChange: false,
      gasSmell: false,
      onMoneyOwed: false,
      disputed: false,
      ...over,
    });
    const byId = (id: string) => EVAL_CASES.find((c) => c.id === id)!;
    const [yes, no, unscored] = [byId("a-lets-do-it"), byId("n-for-less"), byId("q-panel")];
    const right = score(
      [yes, no, unscored],
      [
        result(yes, { acceptsQuote: true }),
        result(no, { acceptsQuote: false }),
        // q-panel has no acceptsQuote key, so even a wrong answer isn't counted.
        result(unscored, { acceptsQuote: true, jobDone: true }),
      ],
    );
    expect(right).toMatchObject({ acceptsQuoteAccuracy: 1, jobDoneAccuracy: 1 });
    const wrong = score(
      [yes, no],
      [result(yes, { acceptsQuote: false }), result(no, { acceptsQuote: true })],
    );
    expect(wrong.acceptsQuoteAccuracy).toBe(0);
  });

  it("covers the round 2 cases (attack guard, fraud, gas, claims, towns, bills, trades)", () => {
    const n = (f: (c: EvalCase) => boolean) => EVAL_CASES.filter(f).length;
    expect(n((c) => c.expect.paymentChange === true)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.gasSmell === true)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.billOwedByBusiness === true)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.routinePaperwork === true)).toBeGreaterThanOrEqual(4);
    expect(n((c) => c.expect.injection === false)).toBeGreaterThanOrEqual(4);
    for (const id of [
      "r2-home-warranty-dispatch",
      "r2-pm-work-order",
      "r2-adjuster-approved",
      "r2-dig-safe",
      "r2-mass-save",
      "r2-manufacturer-registration",
      "r2-gc-portal-task",
      "r2-hoa-approval",
    ])
      expect(
        EVAL_CASES.some((c) => c.id === id),
        id,
      ).toBe(true);
  });

  it("covers the draft-editing prompts too", () => {
    expect(REVISE_CASES.length).toBeGreaterThanOrEqual(8);
    expect(TONE_CASES.length).toBeGreaterThanOrEqual(5);
    // Replies package: every "Other ways to reply" chip has a case.
    for (const k of Object.keys(OPENING_TWEAKS))
      expect(
        REVISE_CASES.some((c) => c.opening === k),
        k,
      ).toBe(true);
  });

  it("covers every first-reply shape (draft.v7) across trades, each drafted", () => {
    const fc = EVAL_CASES.filter((c) => c.firstContact);
    for (const shape of ["details", "vague", "urgent", "price_only"] as const)
      expect(fc.filter((c) => c.firstContact === shape).length, shape).toBeGreaterThanOrEqual(3);
    expect(new Set(fc.map((c) => c.trade)).size).toBeGreaterThanOrEqual(6);
    for (const c of fc) {
      expect(c.draft, c.id).toBeDefined();
      expect(c.firstTimeSender, c.id).toBe(true);
    }
    // Urgent ones need the owner (the emergency lane) and ask for the address.
    for (const c of fc.filter((x) => x.firstContact === "urgent")) {
      expect(c.expect.needsOwner, c.id).toBe(true);
      expect(c.draft!.mustContain, c.id).toContain("address");
    }
  });

  it("covers every purpose draft (#26 #28 #29), with and without payment terms", () => {
    expect(PURPOSE_CASES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PURPOSE_CASES.map((c) => c.id)).size).toBe(PURPOSE_CASES.length);
    const n = (f: (c: (typeof PURPOSE_CASES)[number]) => boolean) => PURPOSE_CASES.filter(f).length;
    expect(n((c) => c.purpose === "deposit" && c.paymentTerms !== null)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.purpose === "deposit" && c.paymentTerms === null)).toBeGreaterThanOrEqual(1);
    expect(n((c) => c.purpose === "review_request")).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.purpose === "closing_question")).toBeGreaterThanOrEqual(1);
    // "Say thanks" (2026-10-16): with and without the review ask.
    expect(n((c) => c.purpose === "thank_you")).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.purpose === "thank_you_review")).toBeGreaterThanOrEqual(1);
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
          accepts_quote: c.expect.acceptsQuote === true,
          job_done: c.expect.jobDone === true,
          payment_change_request: c.expect.paymentChange === true,
          smells_gas: c.expect.gasSmell === true,
          co_alarm: c.expect.coAlarm === true,
          routine_paperwork: c.expect.routinePaperwork === true,
        },
        extracted: {
          ...base.extracted,
          invoice_direction: c.expect.billOwedByBusiness ? "owed_by_business" : "unknown",
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
    let tone = -1;
    const transport: Transport = async (req) => {
      const sys = req.system[0]!.text;
      const isDraft = sys.startsWith("You write email replies");
      const isRevise = sys.startsWith("You revise a reply");
      const isTone = sys.startsWith("You compare two versions");
      if (!isDraft && !isRevise && !isTone) i++;
      const revised = req.user.includes("{{price}}")
        ? "Hi Sam,\n\nIt's {{price}} and I can come {{date}}.\n\nAlex"
        : req.user.includes("out loud")
          ? "Hi Jordan,\n\nThursday morning works, and it's 180 for the visit. What's the address?\n\nAlex"
          : req.user.includes(OPENING_TWEAKS.visit.ask)
            ? "Hi Jordan,\n\nHappy to come take a look. What day suits you, and what's the address?\n\nAlex"
            : "Hi Jordan,\n\nWhat's the address? A photo or two helps.\n\nAlex";
      // draft.v7: a first contact answers with the case's shape, as a good model would.
      const firstContact = req.user.includes("FIRST CONTACT") ? EVAL_CASES[i]!.firstContact : null;
      // Purpose drafts (#28 #29): echo the payment terms / the review link, as a good model would.
      const terms = /- Payment terms: (.*)/.exec(req.system[1]?.text ?? "")?.[1]?.trim();
      const purposeBody = req.user.includes("## Task: deposit")
        ? terms && terms !== "not given"
          ? `Hi Sam,\n\nGreat, thanks for going ahead. For the deposit: ${terms}.\n\nThanks,\nAlex`
          : "Hi Sam,\n\nGreat, thanks for going ahead. I'll be in touch to book it in.\n\nThanks,\nAlex"
        : req.user.includes("## Task: review request")
          ? `Hi Casey,\n\nThanks again for having us out. If you have a minute, a short review would mean a lot:\n${/https:\/\/\S+/.exec(req.user)![0]}\n\nThanks,\nAlex`
          : req.user.includes("## Task: closing question")
            ? "Hi Drew,\n\nDid you go another way, or did the timing change? Either answer is fine.\n\nThanks,\nAlex"
            : req.user.includes("## Task: thank you")
              ? /written on its own line: (\S+)/.test(req.user)
                ? `Hi Jo,\n\nThanks so much for the payment, and for having us out. If you have a minute, a short review would mean a lot:\n${/written on its own line: (\S+)/.exec(req.user)![1]}\n\nThanks,\nAlex`
                : "Hi,\n\nGot it — thank you for taking care of that so quickly. It was good working with you.\n\nThanks,\nAlex"
              : null;
      const parsed = isTone
        ? { tone_shift: TONE_CASES[++tone]!.expect[0] }
        : isRevise
          ? { body: revised, reason: "Changed.", flags: [], confidence: 0.9, used_facts: [] }
          : isDraft
            ? {
                body:
                  purposeBody ??
                  (firstContact === "urgent"
                    ? "Hi,\n\nSorry to hear it. What's the best number to reach you, and the address?\n\nThanks,\nAlex"
                    : firstContact
                      ? "Hi,\n\nThanks for reaching out, happy to help. Could you send a couple of photos?\n\nThanks,\nAlex"
                      : "Hi,\n\nHappy to help — what's the address?\n\nThanks,\nAlex"),
                reason: "Asked for the address.",
                flags: [],
                confidence: 0.9,
                used_facts: [],
                opening: firstContact ?? "not_first",
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
      acceptsQuoteAccuracy: 1,
      jobDoneAccuracy: 1,
      paymentChangeRecall: 1,
      gasSmellRecall: 1,
      coAlarmRecall: 1,
      gasFalseAlarms: 0,
      billDirectionAccuracy: 1,
      routinePaperworkAccuracy: 1,
      draftPassRate: 1,
      revisePassRate: 1,
      toneAccuracy: 1,
      purposePassRate: 1,
      openingAccuracy: 1,
    });
    expect(run.purposeProblems).toEqual({});
    expect(run.reviseProblems).toEqual({});
    // Every first-contact case was drafted and named its shape.
    const fc = EVAL_CASES.filter((c) => c.firstContact).map((c) => c.id);
    for (const id of fc) expect(run.results.find((r) => r.id === id)?.opening, id).toBeDefined();
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
