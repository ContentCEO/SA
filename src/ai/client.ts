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

const anthropicTransport: Transport = async (req) => {
  client ??= new Anthropic(anthropicClientOptions());
  const response = await client.messages.parse({
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
  return {
    parsed: response.parsed_output ?? null,
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
    // (400, 401…) still counts, so a bug can't loop for free.
    const providerFault =
      !(err instanceof Anthropic.APIError) ||
      err.status === undefined ||
      err.status === 408 ||
      err.status === 429 ||
      err.status >= 500;
    if (providerFault) {
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
