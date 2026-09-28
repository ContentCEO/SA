import type { Transport, TransportResult } from "@/ai/client";
import type { ModelClassification } from "@/ai/prompts/classify.v1";

export function classification(over: Partial<ModelClassification> = {}): ModelClassification {
  return {
    category: "quote_request",
    priority: "normal",
    needs_owner: false,
    needs_owner_reason: null,
    summary: "Dana wants a quote for a 200 amp panel upgrade.",
    confidence: 0.92,
    signals: { mentions_legal: false, mentions_refund_or_dispute: false, large_request: false },
    extracted: {
      service_requested: "panel upgrade",
      address: "12 Elm St",
      dates: [],
      dollar_amounts: [],
      urgency: "normal",
    },
    ...over,
  };
}

/** Returns queued outputs in order (null = unparseable), recording every request. */
export function fakeTransport(outputs: (unknown | null)[]) {
  const calls: Parameters<Transport>[0][] = [];
  const transport: Transport = async (req) => {
    calls.push(req);
    const parsed = outputs.length ? outputs.shift()! : null;
    const r: TransportResult = {
      parsed,
      stopReason: "end_turn",
      usage: { inputTokens: 1500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    return r;
  };
  return { transport, calls };
}
