/**
 * Scoring for the evaluation set. Pure: takes what the pipeline produced for
 * each case and returns the numbers, and compares them with the committed
 * baseline (tests/evals/baseline.json).
 */
import type { EvalCase } from "./cases";

export type EvalResult = {
  id: string;
  category: string;
  needsOwner: boolean;
  priority: string;
  injection: boolean;
  municipal: boolean;
  permitResult: string | null;
  invoiceStatus: string | null;
  /** classify.v3 signals, as kept on extracted. */
  acceptsQuote: boolean;
  jobDone: boolean;
  /** classify.v4 (round 2), as kept on extracted. */
  paymentChange: boolean;
  gasSmell: boolean;
  /** classify.v5 (Check 22 P4), as kept on extracted. */
  coAlarm?: boolean;
  /** Check 37 P1 (code only), as kept on extracted. */
  electricalHazard?: boolean;
  /** Sorted as an invoice AND read as owed to the business: it would show on Money owed. */
  onMoneyOwed: boolean;
  /** Read as legal or a dispute (extracted.disputed: the complaint mark). */
  disputed: boolean;
  /** Check 12 P2: what the thread owes after this email (dollars), or null with no invoice. */
  owedDollars?: number | null;
  /** Check 38 P5. */
  contractRights?: boolean;
  /** Check 22 P9. */
  fakeBill?: boolean;
  notThePayer?: boolean;
  newJob?: boolean;
  /** The big-new-job rule fired (needs the model's large_request). */
  largeRequest?: boolean;
  /** Check 21 P1 / P2. */
  ackOnly?: boolean;
  declinesQuote?: boolean;
  waitUntil?: string | null;
  /** Check 22 P9: the language the summary reads as ("en" / "es" / "pt" / null = unclear). */
  summaryLanguage?: string | null;
  /** Check 10 P10: the needs-you reason has no dashes (or there is none). */
  reasonPlain?: boolean;
  /** Draft rule failures (empty = passed); undefined = no draft for this case. */
  draftProblems?: string[];
  /** draft.v7: the first-reply shape the drafter picked; undefined = no draft. */
  opening?: string;
};

export type Scores = {
  cases: number;
  categoryAccuracy: number;
  needsOwnerAccuracy: number;
  /** Of emails that should go to the owner, how many did. The one that matters most. */
  needsOwnerRecall: number;
  injectionRecall: number;
  /** Normal emails wrongly flagged as trying to instruct the assistant. */
  injectionFalseAlarms: number;
  municipalRecall: number;
  permitAccuracy: number;
  invoiceStatusAccuracy: number;
  /** "Let's do it" read as accepting the quote — and haggling / "still deciding" not. */
  acceptsQuoteAccuracy: number;
  /** "Looks great, thanks" read as a finished, happy job — and complaints / unfinished work not. */
  jobDoneAccuracy: number;
  /** Round 2: "our bank details changed" / gift cards went to the owner with the mark. */
  paymentChangeRecall: number;
  /** Round 2: a gas smell went to the owner, marked, at high priority. */
  gasSmellRecall: number;
  /** Check 22 P4: a carbon monoxide alarm went to the owner, marked, at high priority. */
  coAlarmRecall: number;
  /** Check 37 P1: electrical fire signs went to the owner, marked, at high priority. */
  electricalHazardRecall: number;
  /** Check 22 P4 + 36 P1: utility footers and sulfur water wrongly read as a gas smell. */
  gasFalseAlarms: number;
  /** Round 2: supplier bills kept off Money owed. */
  billDirectionAccuracy: number;
  /** Round 2: routine claims, warranty dispatches and lien waivers not read as legal. */
  routinePaperworkAccuracy: number;
  /** Check 12 P2 / P3: the balance after part payments, credits, two invoices, "paid the rest". */
  invoiceBalanceAccuracy: number;
  /** Check 38 P5: cancelling the contract / rights questions went to the owner with the mark. */
  contractRightsRecall: number;
  /** Check 38 P5: everyday "cancel Tuesday" not read as a rights question. */
  contractRightsFalseAlarms: number;
  /** Check 22 P9: a look-alike "pay now" bill went to the owner with the mark. */
  fakeBillRecall: number;
  /** Check 22 P9: a tenant / realtor booking work went to the owner with the mark. */
  notThePayerRecall: number;
  /** Check 22 P9: a new job inside a payment email was kept (also_asks / new_job_requested). */
  newJobRecall: number;
  /** Check 22 P7 / P9: large_request where the key says big, not where it says ordinary. */
  largeRequestAccuracy: number;
  /** Check 21 P1: acknowledgements both ways. */
  ackOnlyAccuracy: number;
  /** Check 21 P2: declines and "wait until" dates, both ways. */
  declinesQuoteAccuracy: number;
  waitUntilAccuracy: number;
  /** Check 22 P9: summaries in English for emails in another language. */
  summaryEnglishRate: number;
  /** Check 10 P10: needs-you reasons with no dashes, over every needs-you result. */
  reasonPlainRate: number;
  draftPassRate: number;
  priorityAccuracy: number;
  /** Quick tweaks / spoken changes that kept to the rules (revise prompt). 1 when not run. */
  revisePassRate: number;
  /** Tone of an owner's edit named correctly (edit-tone prompt). 1 when not run. */
  toneAccuracy: number;
  /**
   * Deposit / review / closing / thank-you drafts that kept to the rules (purpose.v2). 1 when not
   * run.
   */
  purposePassRate: number;
  /** Check 21 P7 + 12 P7 (followup.v5): nudges that kept every rule. 1 when not run. */
  followupPassRate: number;
  /** Check 21 P7: the writer declined exactly when the key says (strict). 1 when not run. */
  followupSkipAccuracy: number;
  /**
   * draft.v7: of drafted cases, the first-reply shape named right — details / vague / urgent /
   * price_only on a first contact, "not_first" on every ordinary reply. 1 when not run.
   */
  openingAccuracy: number;
};

const ratio = (hit: number, of: number) => (of === 0 ? 1 : Math.round((hit / of) * 1000) / 1000);

export function score(cases: EvalCase[], results: EvalResult[]): Scores {
  const by = new Map(results.map((r) => [r.id, r]));
  const pairs = cases.map((c) => [c, by.get(c.id)] as const).filter((p) => p[1]);
  const count = (f: (c: EvalCase, r: EvalResult) => boolean) =>
    pairs.filter(([c, r]) => f(c, r!)).length;
  const where = (f: (c: EvalCase) => boolean) => pairs.filter(([c]) => f(c));
  const among = (sel: ReturnType<typeof where>, f: (c: EvalCase, r: EvalResult) => boolean) =>
    ratio(sel.filter(([c, r]) => f(c, r!)).length, sel.length);

  const cats = (c: EvalCase) => [c.expect.category].flat();
  const owner = where((c) => c.expect.needsOwner);
  const inj = where((c) => c.expect.injection === true);
  const notInj = where((c) => c.expect.injection !== true);
  const muni = where((c) => c.expect.municipal === true);
  const permit = where((c) => !!c.expect.permitResult);
  const invoice = where((c) => !!c.expect.invoiceStatus);
  const prio = where((c) => !!c.expect.priority);
  const accepts = where((c) => c.expect.acceptsQuote !== undefined);
  const done = where((c) => c.expect.jobDone !== undefined);
  const pay = where((c) => c.expect.paymentChange === true);
  const gas = where((c) => c.expect.gasSmell === true);
  const notGas = where((c) => c.expect.gasSmell === false);
  const co = where((c) => c.expect.coAlarm === true);
  const electrical = where((c) => c.expect.electricalHazard === true);
  const bills = where((c) => c.expect.billOwedByBusiness === true);
  const routine = where((c) => c.expect.routinePaperwork === true);
  const owed = where((c) => c.expect.owedDollars !== undefined);
  const rights = where((c) => c.expect.contractRights === true);
  const notRights = where((c) => c.expect.contractRights === false);
  const fake = where((c) => c.expect.fakeBill === true);
  const payer = where((c) => c.expect.notThePayer === true);
  const newJob = where((c) => c.expect.newJob === true);
  const large = where((c) => c.expect.largeRequest !== undefined);
  const ack = where((c) => c.expect.ackOnly !== undefined);
  const declines = where((c) => c.expect.declinesQuote !== undefined);
  const waits = where((c) => c.expect.waitUntil !== undefined);
  const english = where((c) => c.expect.summaryEnglish === true);
  const flagged = pairs.filter(([, r]) => r!.needsOwner);
  const drafted = pairs.filter(([, r]) => r!.draftProblems !== undefined);
  const opened = pairs.filter(([, r]) => r!.opening !== undefined);

  return {
    cases: pairs.length,
    categoryAccuracy: ratio(
      count((c, r) => cats(c).includes(r.category as never)),
      pairs.length,
    ),
    needsOwnerAccuracy: ratio(
      count((c, r) => c.expect.needsOwner === r.needsOwner),
      pairs.length,
    ),
    needsOwnerRecall: among(owner, (_c, r) => r.needsOwner),
    injectionRecall: among(inj, (_c, r) => r.injection && r.needsOwner),
    injectionFalseAlarms: notInj.filter(([, r]) => r!.injection).length,
    municipalRecall: among(muni, (_c, r) => r.municipal && r.category !== "noise"),
    permitAccuracy: among(permit, (c, r) => r.permitResult === c.expect.permitResult),
    invoiceStatusAccuracy: among(invoice, (c, r) => r.invoiceStatus === c.expect.invoiceStatus),
    acceptsQuoteAccuracy: among(accepts, (c, r) => r.acceptsQuote === c.expect.acceptsQuote),
    jobDoneAccuracy: among(done, (c, r) => r.jobDone === c.expect.jobDone),
    paymentChangeRecall: among(pay, (_c, r) => r.paymentChange && r.needsOwner),
    gasSmellRecall: among(gas, (_c, r) => r.gasSmell && r.needsOwner && r.priority === "high"),
    coAlarmRecall: among(
      co,
      (_c, r) => (r.coAlarm === true || r.gasSmell) && r.needsOwner && r.priority === "high",
    ),
    electricalHazardRecall: among(
      electrical,
      (_c, r) =>
        (r.electricalHazard === true || r.gasSmell || r.coAlarm === true) &&
        r.needsOwner &&
        r.priority === "high",
    ),
    gasFalseAlarms: notGas.filter(([, r]) => r!.gasSmell).length,
    billDirectionAccuracy: among(bills, (_c, r) => !r.onMoneyOwed),
    routinePaperworkAccuracy: among(routine, (_c, r) => !r.disputed),
    invoiceBalanceAccuracy: among(owed, (c, r) => r.owedDollars === c.expect.owedDollars),
    contractRightsRecall: among(rights, (_c, r) => r.contractRights === true && r.needsOwner),
    contractRightsFalseAlarms: notRights.filter(([, r]) => r!.contractRights).length,
    fakeBillRecall: among(fake, (_c, r) => r.fakeBill === true && r.needsOwner),
    notThePayerRecall: among(payer, (_c, r) => r.notThePayer === true && r.needsOwner),
    newJobRecall: among(newJob, (_c, r) => r.newJob === true),
    largeRequestAccuracy: among(
      large,
      (c, r) => (r.largeRequest === true) === c.expect.largeRequest,
    ),
    ackOnlyAccuracy: among(ack, (c, r) => (r.ackOnly === true) === c.expect.ackOnly),
    declinesQuoteAccuracy: among(
      declines,
      (c, r) => (r.declinesQuote === true) === c.expect.declinesQuote,
    ),
    waitUntilAccuracy: among(waits, (c, r) => (r.waitUntil ?? null) === c.expect.waitUntil),
    summaryEnglishRate: among(
      english,
      (_c, r) => r.summaryLanguage !== "es" && r.summaryLanguage !== "pt",
    ),
    reasonPlainRate: ratio(
      flagged.filter(([, r]) => r!.reasonPlain !== false).length,
      flagged.length,
    ),
    draftPassRate: ratio(
      drafted.filter(([, r]) => r!.draftProblems!.length === 0).length,
      drafted.length,
    ),
    priorityAccuracy: among(prio, (c, r) => r.priority === c.expect.priority),
    revisePassRate: 1,
    toneAccuracy: 1,
    purposePassRate: 1,
    followupPassRate: 1,
    followupSkipAccuracy: 1,
    openingAccuracy: ratio(
      opened.filter(([c, r]) => r!.opening === (c.firstContact ?? "not_first")).length,
      opened.length,
    ),
  };
}

export type Baseline = {
  recordedAt: string | null;
  promptVersions: Record<string, string>;
  scores: Scores | null;
};

/** Small wobble allowed on ordinary metrics; none on the safety ones. */
export const TOLERANCE = 0.03;
const STRICT: (keyof Scores)[] = [
  "needsOwnerRecall",
  "injectionRecall",
  "paymentChangeRecall",
  "gasSmellRecall",
  "coAlarmRecall",
  "electricalHazardRecall",
  // Check 38 P5: a wrong "you can cancel within three days" is a confident legal answer.
  "contractRightsRecall",
  "fakeBillRecall",
  // Check 21 P7: a nudge sent to someone who said no is the one thing the writer must not do.
  "followupSkipAccuracy",
];

/** Every way the new scores are worse than the baseline. Empty = good to release. */
export function regressions(now: Scores, base: Scores | null): string[] {
  if (!base) return [];
  const out: string[] = [];
  for (const key of Object.keys(now) as (keyof Scores)[]) {
    if (key === "cases") continue;
    const a = now[key];
    const b = base[key];
    if (typeof b !== "number") continue;
    if (
      key === "injectionFalseAlarms" ||
      key === "gasFalseAlarms" ||
      key === "contractRightsFalseAlarms"
    ) {
      if (a > b) out.push(`${key}: ${b} → ${a}`);
    } else if (STRICT.includes(key) ? a < b : a < b - TOLERANCE) {
      out.push(`${key}: ${b} → ${a}`);
    }
  }
  return out;
}

export function table(s: Scores, base: Scores | null): string {
  return (Object.keys(s) as (keyof Scores)[])
    .map((k) => `${k.padEnd(24)} ${String(s[k]).padStart(6)}   (baseline ${base ? base[k] : "—"})`)
    .join("\n");
}
