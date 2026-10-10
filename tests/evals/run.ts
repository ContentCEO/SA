/**
 * Runs the evaluation set through the real pipeline functions (classifyEmail,
 * the drafting prompt, checkDraft) against an in-memory database. The model is
 * whatever transport is set: live Anthropic for `pnpm eval`, a fake in tests.
 */
import { sum } from "drizzle-orm";
import { classifyEmail } from "@/ai/classify";
import { callStructured } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import { CLASSIFY_PROMPT_VERSION } from "@/ai/prompts/classify.v2";
import { EDIT_TONE_PROMPT_VERSION } from "@/ai/prompts/edit-tone.v1";
import { REVISE_PROMPT_VERSION } from "@/ai/prompts/revise.v1";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  draftSchema,
  workspaceBlock,
} from "@/ai/prompts/draft.v5";
import { usage } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createTestDb } from "../support/db";
import type { EvalCase } from "./cases";
import { runEditEvals } from "./edits";
import { score, type EvalResult } from "./score";

export const PROMPT_VERSIONS = {
  classify: CLASSIFY_PROMPT_VERSION,
  draft: DRAFT_PROMPT_VERSION,
  revise: REVISE_PROMPT_VERSION,
  editTone: EDIT_TONE_PROMPT_VERSION,
};

/** A neutral, invented business so drafts have something to work from — and no prices. */
const PROFILE = {
  businessName: "Example Trades Co.",
  services: "Residential repairs and installs",
  serviceArea: "Around Springfield",
  hours: "Mon–Fri 7am–4pm",
  leadTime: "About two weeks out",
  pricingNotes: null,
  paymentTerms: "Due on completion; check or card",
  policies: null,
  signature: "Thanks,\nAlex",
  doNotPromise: ["same-day service"],
  neverSay: ["no problem at all"],
  seasonalNotes: [] as { text: string; endsOn: string }[],
};

export async function runEvals(
  cases: EvalCase[],
  opts: { drafts?: boolean; onProgress?: (done: number, total: number) => void } = {},
) {
  process.env.AI_DAILY_CALL_CAP = "100000";
  const database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "evals@example.com" });
  const results: EvalResult[] = [];
  let done = 0;

  for (const c of cases) {
    const email = {
      fromName: c.fromName,
      fromAddress: c.fromAddress,
      subject: c.subject,
      receivedAt: new Date("2026-10-01T14:00:00Z"),
      firstTimeSender: c.firstTimeSender ?? false,
      threadSummary: null,
      body: c.body,
    };
    const r = await classifyEmail(
      workspace.id,
      {
        businessName: PROFILE.businessName,
        trade: c.trade,
        amountThresholdDollars: 2500,
        vipSenders: [],
      },
      email,
      { senderIsVip: false },
    );
    const result: EvalResult = {
      id: c.id,
      category: r.category,
      needsOwner: r.needsOwner,
      priority: r.priority,
      injection: r.extracted.injection === true,
      municipal: r.extracted.municipal === true,
      permitResult: r.extracted.permit?.result ?? null,
      invoiceStatus: r.extracted.invoice?.status ?? null,
    };

    if (opts.drafts !== false && c.draft) {
      const ctx = { ...PROFILE, trade: c.trade, voice: null };
      const draft = await callStructured({
        workspaceId: workspace.id,
        role: "draft",
        promptVersion: DRAFT_PROMPT_VERSION,
        maxTokens: 2048,
        effort: "medium",
        system: [
          { text: DRAFT_INSTRUCTIONS, cache: false },
          { text: workspaceBlock(ctx), cache: true },
        ],
        user: conversationBlock({
          subject: c.subject,
          category: r.category,
          summary: r.summary,
          extracted: r.extracted,
          messages: [{ from: c.fromName, direction: "in", sentAt: email.receivedAt, body: c.body }],
        }),
        schema: draftSchema,
      });
      const problems: string[] = [];
      if (!draft) problems.push("no usable draft");
      else {
        const check = checkDraft(draft.body, {
          sourceText: [c.body, workspaceBlock(ctx)].join("\n"),
          doNotPromise: PROFILE.doNotPromise,
          neverSay: PROFILE.neverSay,
          phrasesAvoided: [],
        });
        if (c.draft.noInventedMoney)
          problems.push(...check.flags.filter((f) => f.includes("price")));
        if (c.draft.noInventedDates)
          problems.push(...check.flags.filter((f) => f.includes("commit")));
        problems.push(
          ...check.flags.filter(
            (f) =>
              f.includes("never-promise") || f.includes("never-say") || f.includes("stand behind"),
          ),
        );
        for (const bad of c.draft.mustNotContain ?? []) {
          if (draft.body.toLowerCase().includes(bad.toLowerCase())) problems.push(`says "${bad}"`);
        }
      }
      result.draftProblems = problems;
    }
    results.push(result);
    opts.onProgress?.(++done, cases.length);
  }

  const scores = score(cases, results);
  let reviseProblems: Record<string, string[]> = {};
  if (opts.drafts !== false) {
    const edits = await runEditEvals(workspace.id);
    scores.revisePassRate = edits.revisePassRate;
    scores.toneAccuracy = edits.toneAccuracy;
    reviseProblems = edits.reviseProblems;
  }

  const [cost] = await database
    .select({ centiCents: sum(usage.estimatedCostCentiCents).mapWith(Number) })
    .from(usage);
  const [tokens] = await database
    .select({
      in: sum(usage.modelTokensIn).mapWith(Number),
      out: sum(usage.modelTokensOut).mapWith(Number),
    })
    .from(usage);
  return {
    results,
    scores,
    reviseProblems,
    costDollars: (cost?.centiCents ?? 0) / 10_000,
    tokens: { input: tokens?.in ?? 0, output: tokens?.out ?? 0 },
  };
}
