import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setModelTransportForTests, type Transport } from "@/ai/client";
import { CATEGORIES } from "@/ai/prompts/classify.v6";
import { TRADES } from "@/config/trades";
import { EVAL_CASES, type EvalCase } from "../evals/cases";
import { OPENING_TWEAKS } from "@/ai/prompts/opening-tweaks.v1";
import { REVISE_CASES, TONE_CASES } from "../evals/edits";
import { PURPOSE_CASES } from "../evals/purposes";
import { runEvals } from "../evals/run";
import { regressions, score, type Baseline, type EvalResult, type Scores } from "../evals/score";
import { classification, type LooseClassification } from "../support/fake-model";

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

  it("covers classify.v6 (wave 2, Prompt versions step 1) both ways", () => {
    const n = (f: (c: EvalCase) => boolean) => EVAL_CASES.filter(f).length;
    // Check 12 P2 / P3: the four balance threads, "paid the rest", "deposit applied", promises.
    expect(n((c) => c.expect.owedDollars !== undefined)).toBeGreaterThanOrEqual(6);
    expect(n((c) => c.expect.invoiceStatus === "said_sent")).toBeGreaterThanOrEqual(1);
    // Check 22 P9: five lead sites, two voicemails, a tenant, a realtor, a fake bill, a payment
    // with a new job, a Spanish quote, a small job to a remodeler.
    expect(n((c) => c.firstTimeSender === "unknown")).toBeGreaterThanOrEqual(7);
    expect(n((c) => c.expect.notThePayer === true)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.fakeBill === true)).toBeGreaterThanOrEqual(1);
    expect(n((c) => c.expect.newJob === true)).toBeGreaterThanOrEqual(1);
    expect(n((c) => c.expect.summaryEnglish === true)).toBeGreaterThanOrEqual(1);
    expect(n((c) => c.expect.largeRequest === false)).toBeGreaterThanOrEqual(1);
    expect(n((c) => c.expect.largeRequest === true)).toBeGreaterThanOrEqual(1);
    // Check 38 P5: E11, E12 and three everyday negatives.
    expect(n((c) => c.expect.contractRights === true)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.contractRights === false)).toBeGreaterThanOrEqual(3);
    // Check 45 P7: six mark-out / energy-program emails, none junk.
    for (const id of [
      "p1-sunshine-811",
      "p1-texas-811",
      "p1-digalert",
      "p1-energize-ct",
      "p1-efficiency-maine",
      "p1-nhsaves",
    ]) {
      const c = EVAL_CASES.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect([c!.expect.category].flat(), id).not.toContain("noise");
    }
    // Check 21 P1 / P2 (inbox lines): acknowledgements, declines and waits, both ways.
    expect(n((c) => c.expect.ackOnly === true)).toBeGreaterThanOrEqual(3);
    expect(n((c) => c.expect.ackOnly === false)).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.expect.declinesQuote === true)).toBeGreaterThanOrEqual(4);
    expect(n((c) => typeof c.expect.waitUntil === "string")).toBeGreaterThanOrEqual(3);
    expect(
      n((c) => c.expect.declinesQuote === false && c.expect.waitUntil === null),
    ).toBeGreaterThanOrEqual(2);
    // Check 36 P5 / 37 P3 / 40 P2 / 22 P7.
    for (const id of [
      "p1-backflow-due",
      "p1-light-dept-meter-set",
      "p1-photos-only",
      "p1-thumbtack-addition",
    ])
      expect(
        EVAL_CASES.some((c) => c.id === id),
        id,
      ).toBe(true);
  });

  it("covers draft.v9 (wave 2, Prompt versions step 2)", () => {
    const n = (f: (c: EvalCase) => boolean) => EVAL_CASES.filter(f).length;
    expect(n((c) => !!c.draft?.mustAnswer?.length)).toBeGreaterThanOrEqual(1);
    expect(n((c) => !!c.draft?.maxWords)).toBeGreaterThanOrEqual(1);
    expect(n((c) => c.draft?.language === "en")).toBeGreaterThanOrEqual(1);
    // Check 44 P1 + 45 P2: two Texas remodelers whose drafts must not say HIC or CSL.
    expect(n((c) => c.state === "TX" && c.trade === "remodeling")).toBeGreaterThanOrEqual(2);
    expect(n((c) => c.state === "MA")).toBeGreaterThanOrEqual(1);
    // Check 43 P1: "is this a bot?" in English and Spanish, drafted, with no human claim.
    for (const id of ["d9-bot-question-en", "d9-bot-question-es", "d9-permit-question"]) {
      const c = EVAL_CASES.find((x) => x.id === id);
      expect(c?.draft, id).toBeDefined();
    }
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
    const oracle = (c: EvalCase): LooseClassification => {
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
          // classify.v6 (wave 2, Prompt versions step 1).
          large_request: c.expect.largeRequest === true,
          not_the_payer: c.expect.notThePayer === true,
          looks_like_fake_bill: c.expect.fakeBill === true,
          new_job_requested: c.expect.newJob === true,
          acknowledgment_only: c.expect.ackOnly === true,
          declines_quote: c.expect.declinesQuote === true,
        },
        extracted: {
          ...base.extracted,
          invoice_direction: c.expect.billOwedByBusiness ? "owed_by_business" : "unknown",
          // Check 22 P6: every $ figure in the email, as a real model lists them, so the amount
          // rule is exercised.
          dollar_amounts: [
            ...`${c.subject}\n${c.body}`.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)(\s?k\b)?/gi),
          ].map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1)),
          permit: c.expect.permitResult
            ? {
                issuing_body: null,
                permit_number: null,
                inspection_at: null,
                result: c.expect.permitResult,
                corrections: [],
              }
            : null,
          invoice:
            c.keyInvoice ??
            (c.expect.invoiceStatus
              ? {
                  invoice_number: null,
                  amount: null,
                  due_date: null,
                  status: c.expect.invoiceStatus,
                }
              : null),
          other_invoices: c.keyOtherInvoices ?? [],
          wait_until: c.expect.waitUntil ?? null,
          also_asks: c.expect.newJob ? ["quote_request"] : [],
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
                      : // draft.v9: a good model answers each question (the key's words).
                        `Hi,\n\nHappy to help — what's the address?${(EVAL_CASES[i]?.draft?.mustAnswer ?? []).map((w) => ` Yes to ${w}.`).join("")}\n\nThanks,\nAlex`),
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
    // Check 22 P6: with real amounts in the stand-in's answers, every case's needs-you
    // expectation must match what the code decides.
    const wrongNeeds = run.results
      .filter((r) => EVAL_CASES.find((c) => c.id === r.id)!.expect.needsOwner !== r.needsOwner)
      .map((r) => r.id);
    expect(wrongNeeds).toEqual([]);
    expect(run.scores).toMatchObject({
      categoryAccuracy: 1,
      needsOwnerAccuracy: 1,
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
      electricalHazardRecall: 1,
      gasFalseAlarms: 0,
      billDirectionAccuracy: 1,
      routinePaperworkAccuracy: 1,
      invoiceBalanceAccuracy: 1,
      contractRightsRecall: 1,
      contractRightsFalseAlarms: 0,
      fakeBillRecall: 1,
      notThePayerRecall: 1,
      newJobRecall: 1,
      largeRequestAccuracy: 1,
      ackOnlyAccuracy: 1,
      declinesQuoteAccuracy: 1,
      waitUntilAccuracy: 1,
      summaryEnglishRate: 1,
      reasonPlainRate: 1,
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
