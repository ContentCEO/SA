import type { Transport, TransportResult } from "@/ai/client";
import type { z } from "zod";
import { classificationSchema, type ModelClassification } from "@/ai/prompts/classify.v6";

/**
 * A fixture as a test writes it: fields with a `.catch()` default (co_alarm, the classify.v6
 * signals and invoice fields) may be left out, as fixtures written for an older version are.
 * `classification()` runs it through the real schema, so what a test gets back is exactly what
 * the client would hand the code.
 */
type In = z.input<typeof classificationSchema>;
type InvoiceIn = NonNullable<In["extracted"]["invoice"]>;
export type LooseClassification = Omit<In, "extracted"> & {
  extracted: Omit<In["extracted"], "invoice"> & {
    invoice:
      | (Pick<InvoiceIn, "invoice_number" | "amount" | "due_date" | "status"> & Partial<InvoiceIn>)
      | null;
  };
};

export function classification(over: Partial<LooseClassification> = {}): ModelClassification {
  return classificationSchema.parse({ ...base(), ...over });
}

function base(): LooseClassification {
  return {
    category: "quote_request",
    priority: "normal",
    needs_owner: false,
    needs_owner_reason: null,
    summary: "Dana wants a quote for a 200 amp panel upgrade.",
    confidence: 0.92,
    signals: {
      mentions_legal: false,
      mentions_refund_or_dispute: false,
      large_request: false,
      from_building_department: false,
      tries_to_instruct_assistant: false,
      accepts_quote: false,
      job_done: false,
      routine_paperwork: false,
      payment_change_request: false,
      smells_gas: false,
      co_alarm: false,
      not_the_payer: false,
      looks_like_fake_bill: false,
      new_job_requested: false,
      acknowledgment_only: false,
      declines_quote: false,
    },
    extracted: {
      service_requested: "panel upgrade",
      address: "12 Elm St",
      dates: [],
      dollar_amounts: [],
      urgency: "normal",
      permit: null,
      invoice: null,
      other_invoices: [],
      invoice_direction: "unknown",
      also_asks: [],
      wait_until: null,
    },
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
