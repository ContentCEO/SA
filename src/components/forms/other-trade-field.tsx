"use client";

import { useEffect, useRef, useState } from "react";
import { TRADE_OTHER_MAX } from "@/lib/trade-other";
import { TextField } from "./field";

/**
 * Check 41 P4: "Which trade?" — shown when the form's trade select says "other" ("Another trade"
 * / "Something else"). It watches the select in its own form, so the select itself stays as it
 * is. Optional, one line, 60 characters.
 */
export function OtherTradeField({
  initialTrade,
  defaultValue,
  error,
  idBase,
}: {
  initialTrade: string | null | undefined;
  defaultValue?: string | null;
  error?: string[];
  idBase?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [trade, setTrade] = useState(initialTrade ?? "");
  useEffect(() => {
    const form = ref.current?.closest("form");
    const select = form?.querySelector<HTMLSelectElement>('select[name="trade"]');
    if (!select) return;
    const sync = () => setTrade(select.value);
    sync();
    select.addEventListener("change", sync);
    return () => select.removeEventListener("change", sync);
  }, []);
  return (
    <div ref={ref}>
      {trade === "other" ? (
        <TextField
          name="tradeOther"
          idBase={idBase}
          label="Which trade? (optional)"
          hint={`For example lawn care or pest control. Up to ${TRADE_OTHER_MAX} letters.`}
          defaultValue={defaultValue ?? undefined}
          error={error}
        />
      ) : null}
    </div>
  );
}
