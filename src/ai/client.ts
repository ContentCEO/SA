import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { models, type ModelRole } from "@/config/models";
import { estimateCostCentiCents, type TokenUsage } from "./cost";
import { recordAiUsage, reserveAiCall } from "./usage";

/** One structured model call. `system` blocks are cached; `user` is the per-request part. */
export type StructuredRequest = {
  model: string;
  maxTokens: number;
  system: { text: string; cache: boolean }[];
  user: string;
  schema: z.ZodType;
};

export type TransportResult = {
  parsed: unknown | null;
  usage: TokenUsage;
  stopReason: string | null;
};
export type Transport = (req: StructuredRequest) => Promise<TransportResult>;

let client: Anthropic | undefined;

const anthropicTransport: Transport = async (req) => {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system.map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    })),
    messages: [{ role: "user", content: req.user }],
    output_config: { format: zodOutputFormat(req.schema) },
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
    });
  } catch (err) {
    console.error("ai_call_failed", {
      promptVersion: opts.promptVersion,
      model,
      latencyMs: Date.now() - started,
      error: err instanceof Anthropic.APIError ? `${err.status}` : (err as Error).name,
    });
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
