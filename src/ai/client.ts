import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { anthropicClientOptions } from "@/config/e2e";
import { models, type ModelRole } from "@/config/models";
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
  client ??= new Anthropic(anthropicClientOptions());
  // Check 29 P1: messages.create with the same parameters messages.parse sends (parse is create
  // plus a parser that throws on a bad answer); we parse the text ourselves below.
  const response = await client.messages.create({
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
  });
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
  now?: Date;
}): Promise<z.infer<S> | null> {
  const now = opts.now ?? new Date();
  await reserveAiCall(opts.workspaceId, now);

  const model = models[opts.role];
  const started = Date.now();
  let result: TransportResult;
  try {
    result = await transport({
      model,
      maxTokens: opts.maxTokens,
      system: opts.system,
      user: opts.user,
      schema: opts.schema,
      effort: opts.effort,
    });
  } catch (err) {
    console.error("ai_call_failed", {
      promptVersion: opts.promptVersion,
      model,
      latencyMs: Date.now() - started,
      error: err instanceof Anthropic.APIError ? `${err.status}` : (err as Error).name,
    });
    // The provider failed (outage, overload, rate limit, timeout, no connection): the call
    // doesn't count against the day (review D5). A request the provider refused as wrong
    // (400, 401…) still counts, so a bug can't loop for free; so does any error of our own
    // (Check 29 P1: only the provider's faults are handed back).
    if (isProviderFault(err)) {
      try {
        await refundAiCall(opts.workspaceId, now);
      } catch (refundErr) {
        console.error("ai_call_refund_failed", {
          workspaceId: opts.workspaceId,
          error: refundErr instanceof Error ? refundErr.name : "unknown",
        });
      }
    }
    throw err;
  }

  // Every answer the provider returned is billed, valid or not: record it (Check 29 P1).
  const costCentiCents = estimateCostCentiCents(model, result.usage);
  await recordAiUsage(opts.workspaceId, { ...result.usage, costCentiCents }, now);

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
  });
  return validated.success ? validated.data : null;
}
