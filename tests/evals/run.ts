/**
 * Runs the evaluation set through the real pipeline (Check 22 P12: each email is stored as a
 * thread in an in-memory database and sorted by `classifyPending`, so the Promotions shortcut,
 * the first-time rule, Reply-To handling and the sticky marks are scored too), the drafting
 * prompt and `checkDraft` with the app's own context (`buildCheckContext`). The model is whatever
 * transport is set: live Anthropic for `pnpm eval`, a fake in tests.
 */
import { randomBytes } from "node:crypto";
import { eq, sum } from "drizzle-orm";
import { callStructured } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import { chooseReplyLanguage, detectLanguage } from "@/ai/language";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  FIRST_CONTACT_TASK,
  replyDraftSchema,
  workspaceBlock,
} from "@/ai/prompts/draft.v9";
import { DISPUTE_TASK } from "@/ai/prompts/dispute-caution.v1";
import { ACTIVE } from "@/ai/prompts/registry";
import type { Extracted } from "@/ai/classify";
import { messages, threads, usage, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import { buildCheckContext, type DraftContext } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { invoiceOf, owedCents } from "@/server/money-rules";
import { createTestDb } from "../support/db";
import type { EvalCase } from "./cases";
import { runEditEvals } from "./edits";
import { runFollowupEvals } from "./followups";
import { DEFAULT_PAYMENT_TERMS, runPurposeEvals } from "./purposes";
import { runVoiceExamplesEvals } from "./voice-examples";
import { FIXED_VOICES, runVoiceEvals } from "./voice-cases";
import { score, type EvalResult } from "./score";

/** The prompt versions an eval run used (stored with the baseline). */
export const PROMPT_VERSIONS: Record<string, string> = { ...ACTIVE };

/**
 * The case being run, so a stand-in model in tests can answer for it (the order of model calls
 * isn't one per case: a Promotions email gets none).
 */
export const evalState: { caseId: string | null; voiceId: string | null } = {
  caseId: null,
  voiceId: null,
};

/** A neutral, invented business so drafts have something to work from — and no prices. */
const PROFILE = {
  businessName: "Example Trades Co.",
  services: "Residential repairs and installs",
  serviceArea: "Around Springfield",
  hours: "Mon–Fri 7am–4pm",
  leadTime: "About two weeks out",
  pricingNotes: null,
  paymentTerms: DEFAULT_PAYMENT_TERMS,
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
  process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  const database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "evals@example.com" });
  const mailbox = await saveConnectedMailbox(workspace, {
    email: "evals@example.com",
    refreshToken: "evals",
    grantedScopes: [],
  });
  const results: EvalResult[] = [];
  let done = 0;

  for (const c of cases) {
    evalState.caseId = c.id;
    const receivedAt = new Date(
      c.receivedAt ? `${c.receivedAt}T14:00:00Z` : "2026-10-01T14:00:00Z",
    );
    const email = { receivedAt };
    // Check 22 P12: a fresh conversation per case, sorted the way the app sorts it.
    await database.delete(messages).where(eq(messages.mailboxId, mailbox.id));
    await database.delete(threads).where(eq(threads.mailboxId, mailbox.id));
    await database
      .update(workspaces)
      // An account that can run jobs on any case's date (an evaluation clock started today
      // would make a December case read-only).
      .set({ trade: c.trade, businessName: PROFILE.businessName, status: "active" })
      .where(eq(workspaces.id, workspace.id));
    const at = (minutesBefore: number) => new Date(receivedAt.getTime() - minutesBefore * 60_000);
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId: mailbox.id,
        gmailThreadId: `eval-${c.id}`,
        inInbox: true,
        subject: c.subject,
        summary: c.threadSummary ?? null,
        lastMessageAt: receivedAt,
        // Check 12 P2: what the thread already held, so the stored balance is scored.
        ...(c.priorInvoice
          ? {
              category: "invoice_payment",
              extracted: { invoice: c.priorInvoice, invoice_thread: true },
              classifiedAt: at(60 * 24 * 3),
            }
          : {}),
      })
      .returning();
    // The first-time rule: an earlier email from this sender (on another thread) unless the case
    // says they're new, or it's a lead-site / voicemail robot ("unknown").
    const prior = c.prior ?? (c.firstTimeSender === undefined || c.firstTimeSender === false);
    if (prior) {
      const [old] = await database
        .insert(threads)
        .values({
          mailboxId: mailbox.id,
          gmailThreadId: `eval-${c.id}-old`,
          inInbox: true,
          subject: "Earlier",
          category: "customer_question",
          classifiedAt: at(60 * 24 * 20),
          lastMessageAt: at(60 * 24 * 20),
        })
        .returning();
      await database.insert(messages).values({
        threadId: old!.id,
        mailboxId: mailbox.id,
        gmailMessageId: `eval-${c.id}-old`,
        direction: "in",
        fromAddress: c.fromAddress,
        fromName: c.fromName,
        subject: "Earlier",
        bodyText: "Thanks again.",
        labelIds: ["INBOX"],
        replyToHeader: {},
        sentAt: at(60 * 24 * 20),
        classifiedAt: at(60 * 24 * 20),
      });
    }
    // Older emails on the same thread (the owner's price before "go ahead", say).
    for (const [n, e] of (c.earlier ?? []).entries()) {
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: mailbox.id,
        gmailMessageId: `eval-${c.id}-e${n}`,
        direction: e.direction,
        fromAddress: e.direction === "in" ? c.fromAddress : "evals@example.com",
        fromName: e.direction === "in" ? c.fromName : "Alex",
        toAddresses: e.direction === "out" ? [c.fromAddress] : [],
        subject: c.subject,
        bodyText: e.body,
        labelIds: e.direction === "in" ? ["INBOX"] : ["SENT"],
        replyToHeader: {},
        sentAt: at(e.minutesBefore),
        classifiedAt: at(e.minutesBefore),
      });
    }
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId: mailbox.id,
      gmailMessageId: `eval-${c.id}`,
      direction: "in",
      fromAddress: c.fromAddress,
      fromName: c.fromName,
      toAddresses: ["evals@example.com"],
      subject: c.subject,
      bodyText: c.body,
      snippet: c.body.slice(0, 120),
      labelIds: c.labels ?? ["INBOX"],
      replyToHeader: c.replyTo ? { address: c.replyTo } : {},
      // Check 40 P2: the "Attached: …" line, as the app passes it.
      attachmentImages: c.attachments?.images ?? 0,
      attachmentPdfs: c.attachments?.pdfs ?? 0,
      attachmentOther: c.attachments?.other ?? 0,
      sentAt: receivedAt,
    });
    await classifyPending(mailbox.id, { now: new Date(receivedAt.getTime() + 3_600_000) });
    const [row] = await database.select().from(threads).where(eq(threads.id, t!.id));
    const r = {
      category: row!.category ?? "unsorted",
      needsOwner: row!.needsOwner,
      needsOwnerReason: row!.needsOwnerReason,
      priority: row!.priority ?? "normal",
      summary: row!.summary ?? "",
      extracted: (row!.extracted ?? {}) as Extracted & Record<string, unknown>,
    };
    // Check 12 P2: the balance the thread now holds (carried by classification.ts).
    const carried = invoiceOf(r.extracted);

    const result: EvalResult = {
      id: c.id,
      category: r.category,
      needsOwner: r.needsOwner,
      priority: r.priority,
      injection: r.extracted.injection === true,
      municipal: r.extracted.municipal === true,
      permitResult: r.extracted.permit?.result ?? null,
      invoiceStatus: r.extracted.invoice?.status ?? null,
      acceptsQuote: r.extracted.accepts_quote === true,
      jobDone: r.extracted.job_done === true,
      paymentChange: r.extracted.payment_change === true,
      gasSmell: r.extracted.gas_smell === true,
      coAlarm: r.extracted.co_alarm === true,
      electricalHazard: r.extracted.electrical_hazard === true,
      onMoneyOwed:
        r.category === "invoice_payment" && r.extracted.invoice_direction !== "owed_by_business",
      disputed: r.extracted.disputed === true,
      owedDollars: carried ? owedCents(carried) / 100 : null,
      urgency: typeof r.extracted.urgency === "string" ? r.extracted.urgency : undefined,
      contractRights: r.extracted.contract_rights === true,
      fakeBill: r.extracted.fake_bill === true,
      notThePayer: r.extracted.not_the_payer === true,
      newJob:
        r.extracted.new_job_requested === true ||
        (r.extracted.also_asks ?? []).includes("quote_request"),
      largeRequest: (r.extracted.owner_rule_hits ?? []).includes("big_new_job"),
      ackOnly: r.extracted.acknowledgment_only === true,
      declinesQuote: r.extracted.declines_quote === true,
      waitUntil: r.extracted.wait_until ?? null,
      summaryLanguage: detectLanguage(r.summary),
      reasonPlain: r.needsOwnerReason === null || !/[—–]| - /.test(r.needsOwnerReason),
    };

    if (opts.drafts !== false && c.draft) {
      // draft.v9 (Check 44 P1 + 45 P2): the owner's state decides the state words in the block.
      const ctx = {
        ...PROFILE,
        trade: c.trade,
        // Check 24 P10: drafts with a fixed voice must follow its greeting, sign-off and length.
        voice: c.voice ? FIXED_VOICES[c.voice] : null,
        state: c.state ?? null,
      };
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
          now: email.receivedAt,
          subject: c.subject,
          category: r.category,
          summary: r.summary,
          extracted: r.extracted,
          // draft.v7: a first contact gets the task line the app sends (replies package).
          task: c.firstContact
            ? FIRST_CONTACT_TASK
            : c.disputeCaution
              ? // Check 43 P9: the fixed task the app adds on dispute / legal threads.
                `Write the owner's reply to the last CUSTOMER message.\n\n${DISPUTE_TASK}`
              : undefined,
          messages: [
            {
              from: c.fromName,
              direction: "in",
              sentAt: email.receivedAt,
              body: c.body,
              attachments: c.attachments ?? null,
            },
          ],
          // draft.v9 (Check 43 P8): the eval profile answers in English only.
          replyLanguage: chooseReplyLanguage(detectLanguage(c.body), ["en"]),
        }),
        schema: replyDraftSchema,
      });
      const problems: string[] = [];
      if (!draft) problems.push("no usable draft");
      else {
        // Check 23 P12: the same check context the app builds (buildCheckContext).
        const draftCtx: DraftContext = { ...ctx, licenses: {}, reviewUrl: null, timeZone: null };
        const check = checkDraft(
          draft.body,
          buildCheckContext({
            ctx: draftCtx,
            conversation: [{ m: { direction: "in", sentAt: email.receivedAt }, text: c.body }],
            ownerNote: null,
            now: email.receivedAt,
            replyLanguage: chooseReplyLanguage(detectLanguage(c.body), ["en"]).reply,
            firstContact: !!c.firstContact,
            knownNames: [c.fromName],
          }),
        );
        if (c.draft.noInventedMoney)
          problems.push(...check.flags.filter((f) => f.includes("price")));
        if (c.draft.noInventedDates)
          problems.push(...check.flags.filter((f) => f.includes("commit")));
        problems.push(
          ...check.flags.filter(
            (f) =>
              f.includes("never-promise") ||
              f.includes("never-say") ||
              f.includes("stand behind") ||
              // draft.v8 (Check 38 P6): no made-up license number, no unbacked credential.
              f.includes("license or registration number") ||
              f.includes("Add it in Settings") ||
              // Check 40 P1: no deductible or insurance-claim promises.
              f.includes("deductible or the insurance claim") ||
              // Check 41 P1: no safety or lead claims.
              f.includes("Safety and lead claims") ||
              // Check 39 P4: no rebate, tax-credit or refrigerant rule the owner never wrote.
              f.includes("rebate, tax credit or refrigerant rule"),
          ),
        );
        for (const bad of c.draft.mustNotContain ?? []) {
          if (draft.body.toLowerCase().includes(bad.toLowerCase())) problems.push(`says "${bad}"`);
        }
        for (const good of c.draft.mustContain ?? []) {
          if (!draft.body.toLowerCase().includes(good.toLowerCase()))
            problems.push(`missing "${good}"`);
        }
        // draft.v9 (Check 23 P11): every question answered, short replies to short emails,
        // and the reply in the language the owner chose.
        // Check 23 P12: asks for what's missing, and no price gap before it has the details.
        for (const word of c.draft.mustAsk ?? []) {
          if (!draft.body.toLowerCase().includes(word.toLowerCase()))
            problems.push(`didn't ask about "${word}"`);
        }
        if (c.draft.noGapsWhenAskingFirst && draft.body.includes("{{price}}"))
          problems.push("a price gap before the details");
        if (/\b(a|the) (date|time|day) \{\{(date|time)\}\}/i.test(draft.body))
          problems.push("a gap after the words it replaces");
        // Check 24 P10: a fixed voice's greeting, sign-off and length (±50%).
        if (c.voice) {
          const v = FIXED_VOICES[c.voice];
          const body = draft.body.trim();
          if (v.greetingStyle && !body.toLowerCase().startsWith(v.greetingStyle.toLowerCase()))
            problems.push("not the owner's greeting");
          if (v.signoffStyle && !body.toLowerCase().includes(v.signoffStyle.toLowerCase()))
            problems.push("not the owner's sign-off");
          const words = body.split(/\s+/).length;
          const avg = v.avgLengthWords ?? 60;
          if (words < avg * 0.5 || words > avg * 1.5) problems.push(`${words} words for ${avg}`);
        }
        for (const word of c.draft.mustAnswer ?? []) {
          if (!draft.body.toLowerCase().includes(word.toLowerCase()))
            problems.push(`didn't answer "${word}"`);
        }
        if (c.draft.maxWords) {
          const words = draft.body.trim().split(/\s+/).length;
          if (words > c.draft.maxWords) problems.push(`${words} words, over ${c.draft.maxWords}`);
        }
        if (c.draft.language) {
          const read = detectLanguage(draft.body);
          if (read && read !== c.draft.language) problems.push(`reads as ${read}`);
        }
        // The shape the drafter picked: first contacts' own, "not_first" for everything else.
        result.opening = draft.opening;
      }
      result.draftProblems = problems;
    }
    results.push(result);
    opts.onProgress?.(++done, cases.length);
  }

  const scores = score(cases, results);
  let reviseProblems: Record<string, string[]> = {};
  let purposeProblems: Record<string, string[]> = {};
  let followupProblems: Record<string, string[]> = {};
  let voiceExamplesProblems: Record<string, string[]> = {};
  let voiceProblems: Record<string, string[]> = {};
  if (opts.drafts !== false) {
    // Check 24 P10: the voice prompt on six invented sent-mail batches.
    const voices = await runVoiceEvals(workspace.id, (id) => (evalState.voiceId = id));
    scores.voicePassRate = voices.voicePassRate;
    scores.voiceNoCustomerDetails = voices.voiceNoCustomerDetails;
    voiceProblems = voices.voiceProblems;
    // Check 24 P8: sample replies from the stored voice settings (voice-examples.v1).
    const samples = await runVoiceExamplesEvals(workspace.id);
    scores.voiceExamplesPassRate = samples.voiceExamplesPassRate;
    voiceExamplesProblems = samples.voiceExamplesProblems;
    // Check 21 P7 + 12 P7: the nudge writer (followup.v5), skips and invoice reminders.
    const nudges = await runFollowupEvals(workspace.id);
    scores.followupPassRate = nudges.followupPassRate;
    scores.followupSkipAccuracy = nudges.followupSkipAccuracy;
    followupProblems = nudges.followupProblems;
    const edits = await runEditEvals(workspace.id);
    scores.revisePassRate = edits.revisePassRate;
    scores.toneAccuracy = edits.toneAccuracy;
    reviseProblems = edits.reviseProblems;
    const purposes = await runPurposeEvals(workspace.id);
    scores.purposePassRate = purposes.purposePassRate;
    purposeProblems = purposes.purposeProblems;
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
    purposeProblems,
    followupProblems,
    voiceExamplesProblems,
    voiceProblems,
    costDollars: (cost?.centiCents ?? 0) / 10_000,
    tokens: { input: tokens?.in ?? 0, output: tokens?.out ?? 0 },
  };
}
