import { MUNICIPAL_NAME_ONLY_CAUTION } from "@/ai/guards";
import { cn } from "@/lib/utils";

type Permit = {
  issuing_body?: string | null;
  permit_number?: string | null;
  inspection_at?: string | null;
  result?: "passed" | "failed" | "scheduled" | "other" | null;
  corrections?: string[];
};

const resultWords = {
  passed: "Passed",
  failed: "Failed",
  scheduled: "Inspection scheduled",
  other: "Permit update",
} as const;

/**
 * Check 37 P2: the Inbox row's one-line permit note while it's folded, only when there's a fix
 * list: "Permit E-26-0412 · 3 things to fix".
 */
export function permitSummaryLine(permit: Permit | null | undefined): string | null {
  const n = permit?.corrections?.length ?? 0;
  if (!permit || n === 0) return null;
  const fix = `${n} thing${n === 1 ? "" : "s"} to fix`;
  return permit.permit_number ? `Permit ${permit.permit_number} · ${fix}` : fix;
}

/** Permit / inspection facts pulled from the email (feature plan #17). Status by weight, not colour. */
export function PermitCard({ permit }: { permit: Permit | null | undefined }) {
  if (!permit) return null;
  const failed = permit.result === "failed";
  const facts = [
    permit.issuing_body,
    permit.permit_number ? `Permit ${permit.permit_number}` : null,
    permit.inspection_at ? `Inspection ${permit.inspection_at}` : null,
  ].filter(Boolean);
  return (
    <section
      aria-label="Permit or inspection"
      className="flex flex-col gap-1.5 rounded-lg border-2 border-current p-3 text-sm"
    >
      <p className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-black",
            // Inverted against whatever it sits on (a charcoal Needs-you card too).
            failed ? "bg-primary text-primary-foreground" : "border border-current",
          )}
        >
          {resultWords[permit.result ?? "other"]}
        </span>
        {facts.length ? <span>{facts.join(" · ")}</span> : null}
      </p>
      {permit.corrections?.length ? (
        <div>
          <p className="font-semibold">
            {permit.corrections.length} thing{permit.corrections.length === 1 ? "" : "s"} to fix:
          </p>
          <ul className="list-disc pl-5">
            {permit.corrections.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Check 22 P8: only the sender's name says town office, and it writes from a personal address
 * (gmail.com and the like). Text only, two-tone.
 */
export function TownCaution({ extracted }: { extracted: unknown }) {
  if ((extracted as { municipal_name_only?: unknown } | null)?.municipal_name_only !== true)
    return null;
  return <p className="text-sm font-semibold">Careful: {MUNICIPAL_NAME_ONLY_CAUTION}</p>;
}
