import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { anthropicClientOptions } from "@/config/e2e";
import {
  aiMaxRetries,
  aiTimeouts,
  modelFallbacks,
  models,
  type ModelId,
  type ModelRole,
} from "@/config/models";
import { recordModelDown } from "@/server/model-alerts";
import { estimateCostCentiCents, type TokenUsage } from "./cost";
import { recordAiUsage, refundAiCall, reserveAiCall } from "./usage";

/** One structured model call. `system` blocks are cached; `user` is the per-request part. */
export type StructuredRequest = {
  model: string;
  maxTokens: number;
  system: { text: string; cache: boolean }[];
  user: string;
  schema: z.ZodType;
  /** Sonnet only; Haiku 4.5 rejects the effort setting. */
  effort?: "low" | "medium" | "high";
  /** Check 48 P4: the SDK's time limit for this request, in milliseconds. */
  timeoutMs?: number;
};

export type TransportResult = {
  parsed: unknown | null;
  usage: TokenUsage;
  stopReason: string | null;
};
export type Transport = (req: StructuredRequest) => Promise<TransportResult>;

let client: Anthropic | undefined;

/**
 * Check 29 P1: the model's answer, checked by us. JSON that doesn't parse or doesn't match the
 * schema (often cut off at max_tokens) is `null` with the real usage, never a thrown error: the
 * call was billed, so it's recorded, and the caller's retry-once / unreadable path runs.
 */
export function parseStructuredText(text: string | null, schema: z.ZodType): unknown | null {
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const checked = schema.safeParse(json);
  return checked.success ? checked.data : null;
}

const anthropicTransport: Transport = async (req) => {
  // Check 48 P4: one retry and a time limit that fits the server's (e2e mode keeps its own).
  client ??= new Anthropic({
    maxRetries: aiMaxRetries,
    timeout: aiTimeouts.jobMs,
    ...anthropicClientOptions(),
  });
  // Check 29 P1: messages.create with the same parameters messages.parse sends (parse is create
  // plus a parser that throws on a bad answer); we parse the text ourselves below.
  const response = await client.messages.create(
    {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system.map((b) => ({
        type: "text" as const,
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      })),
      messages: [{ role: "user", content: req.user }],
      output_config: {
        format: zodOutputFormat(req.schema),
        ...(req.effort ? { effort: req.effort } : {}),
      },
    },
    req.timeoutMs ? { timeout: req.timeoutMs } : undefined,
  );
  const text = response.content.find((b) => b.type === "text");
  return {
    parsed: parseStructuredText(text?.type === "text" ? text.text : null, req.schema),
    stopReason: response.stop_reason ?? null,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
};

let transport: Transport = anthropicTransport;

type Fallbacks = Record<ModelRole, { model: ModelId; fallbackApproved: boolean }>;
let fallbacks: Fallbacks = modelFallbacks;

/** Tests only: pretend Davi approved (or not) a stand-in. */
export function setModelFallbacksForTests(f: Fallbacks | undefined) {
  fallbacks = f ?? modelFallbacks;
}

/** Tests only. */
export function setModelTransportForTests(t: Transport | undefined) {
  transport = t ?? anthropicTransport;
}

/**
 * A fault on the provider's side: an API error with no status, 408, 429 or 5xx (529 overloaded
 * included), or no connection / a timeout (APIConnectionError and its timeout subclass).
 */
export function isProviderFault(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  return err.status === undefined || err.status === 408 || err.status === 429 || err.status >= 500;
}

/**
 * Check 48 P3: Anthropic says the model doesn't exist or isn't available (a 404, or a 400 that
 * says so). The reserved call is handed back and jobs stop retrying (NonRetriableError); the
 * email stays unsorted and is picked up once the model works again.
 */
export class ModelUnavailableError extends Error {
  override readonly name = "ModelUnavailableError";
  constructor(
    public readonly role: ModelRole,
    public readonly model: string,
    options?: { cause?: unknown },
  ) {
    super(`Model ${model} (${role}) is not available.`, options);
  }
}

const MODEL_GONE =
  /\bmodel\b.*\b(not found|not available|unavailable|not supported|does not exist|retired|deprecated)\b/i;

/** A 404, or a 400 whose message says the model isn't available. */
export function isModelUnavailable(err: unknown): boolean {
  if (err instanceof Anthropic.NotFoundError) return true;
  return err instanceof Anthropic.BadRequestError && MODEL_GONE.test(err.message);
}

/** Overloaded (529) even after the SDK's own retries. */
function isOverloaded(err: unknown): boolean {
  return err instanceof Anthropic.APIError && err.status === 529;
}

/**
 * Check 48 P4: our own cut-off on top of the SDK's, so a request that never answers (or keeps
 * retrying) ends at the limit as a timeout: a provider fault, so the call is refunded.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Anthropic.APIConnectionTimeoutError()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For the owner's taps: the model is slow, down or missing right now, so the plain answer is
 * "try again in a moment" (never a hang or an error page).
 */
export function isTemporaryAiFailure(err: unknown): boolean {
  return err instanceof ModelUnavailableError || isProviderFault(err);
}

/** A content-free label for the ai_call_failed line. */
function errorLabel(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIError && err.status !== undefined) return `${err.status}`;
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Make a structured call on behalf of a workspace: count it against the daily
 * cap first, validate the output with Zod, record tokens and cost, and log
 * only metadata (prompt version, model, tokens, latency) — never content.
 * Returns null when the output didn't validate; callers decide what that means.
 */
export async function callStructured<S extends z.ZodType>(opts: {
  workspaceId: string;
  role: ModelRole;
  promptVersion: string;
  maxTokens: number;
  system: { text: string; cache: boolean }[];
  user: string;
  schema: S;
  effort?: "low" | "medium" | "high";
  /** Check 48 P4: "interactive" when the owner is waiting on a tap (45 s), else "job" (90 s). */
  mode?: "interactive" | "job";
  now?: Date;
}): Promise<z.infer<S> | null> {
  const now = opts.now ?? new Date();
  await reserveAiCall(opts.workspaceId, now);

  // Check 48 P3: one stand-in try per call, only when Davi approved it for this role.
  const fallback = fallbacks[opts.role];
  let model: ModelId = models[opts.role];
  let fallbackUsed = false;
  const started = Date.now();
  // One deadline for the whole call, stand-in included: no call outlives its limit.
  const limitMs = opts.mode === "interactive" ? aiTimeouts.interactiveMs : aiTimeouts.jobMs;
  const deadline = started + limitMs;
  let result: TransportResult;
  for (;;) {
    try {
      const leftMs = deadline - Date.now();
      if (leftMs <= 0) throw new Anthropic.APIConnectionTimeoutError();
      result = await withDeadline(
        transport({
          model,
          maxTokens: opts.maxTokens,
          system: opts.system,
          user: opts.user,
          schema: opts.schema,
          effort: opts.effort,
          timeoutMs: leftMs,
        }),
        leftMs,
      );
      break;
    } catch (err) {
      const missing = isModelUnavailable(err);
      console.error("ai_call_failed", {
        promptVersion: opts.promptVersion,
        model,
        latencyMs: Date.now() - started,
        error: errorLabel(err),
        fallbackUsed,
      });
      if (missing) {
        console.error("ai_model_unavailable", {
          role: opts.role,
          model,
          promptVersion: opts.promptVersion,
        });
        await recordModelDown(model, now);
      }
      if (!fallbackUsed && fallback.fallbackApproved && (missing || isOverloaded(err))) {
        fallbackUsed = true;
        model = fallback.model;
        continue;
      }
      // The provider failed (outage, overload, rate limit, timeout, no connection) or the model
      // is gone: the call doesn't count against the day (review D5, Check 48 P3). A request the
      // provider refused as wrong (400, 401…) still counts, so a bug can't loop for free; so
      // does any error of our own (Check 29 P1: only the provider's faults are handed back).
      if (missing || isProviderFault(err)) {
        try {
          await refundAiCall(opts.workspaceId, now);
        } catch (refundErr) {
          console.error("ai_call_refund_failed", {
            workspaceId: opts.workspaceId,
            error: refundErr instanceof Error ? refundErr.name : "unknown",
          });
        }
      }
      if (missing) throw new ModelUnavailableError(opts.role, model, { cause: err });
      throw err;
    }
  }

  // Every answer the provider returned is billed, valid or not: record it (Check 29 P1).
  const costCentiCents = estimateCostCentiCents(model, result.usage);
  await recordAiUsage(
    opts.workspaceId,
    { ...result.usage, costCentiCents, fallbackCalls: fallbackUsed ? 1 : 0 },
    now,
  );

  const validated = opts.schema.safeParse(result.parsed);
  console.info("ai_call", {
    workspaceId: opts.workspaceId,
    promptVersion: opts.promptVersion,
    model,
    latencyMs: Date.now() - started,
    ...result.usage,
    costCentiCents,
    stopReason: result.stopReason,
    valid: validated.success,
    ...(fallbackUsed ? { fallbackUsed: true } : {}),
  });
  return validated.success ? validated.data : null;
}
