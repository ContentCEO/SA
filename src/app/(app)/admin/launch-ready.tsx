import { launchSummary, type LaunchRow } from "@/server/launch-ready";

const STATE_WORDS: Record<LaunchRow["state"], string> = {
  done: "Done",
  "not yet": "Not yet",
  "check by hand": "Check by hand",
};

/**
 * Check 50 P6: "Ready for paying owners". States in plain words, told apart by weight and
 * inversion only (two-tone). Renders labels, states and safe details — never a setting's value.
 */
export function LaunchReady({
  rows,
  tickAction,
}: {
  rows: LaunchRow[];
  tickAction: (formData: FormData) => Promise<void>;
}) {
  const { done, total } = launchSummary(rows);
  return (
    <section
      id="launch"
      aria-labelledby="launch-heading"
      className="flex flex-col gap-3 rounded-xl border-2 border-charcoal p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="launch-heading" className="text-lg font-black">
          Ready for paying owners
        </h2>
        <p className="font-semibold">
          {done} of {total} done
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={r.state === "done" ? "" : "font-semibold"}>{r.label}</span>
              <span
                className={
                  r.state === "not yet"
                    ? "sa-inverted rounded-md px-2 py-0.5 text-sm font-black"
                    : r.state === "check by hand"
                      ? "rounded-md border-2 border-charcoal px-2 py-0.5 text-sm font-black"
                      : "px-2 py-0.5 text-sm"
                }
              >
                {STATE_WORDS[r.state]}
                {r.detail ? ` · ${r.detail}` : ""}
              </span>
            </div>
            {r.state !== "done" ? <p className="text-sm text-muted-foreground">{r.how}</p> : null}
            {r.hand && r.state !== "done" ? (
              <form action={tickAction}>
                <input type="hidden" name="key" value={r.key} />
                <button
                  type="submit"
                  aria-label={`Done: ${r.label}`}
                  className="min-h-tap min-w-tap rounded-md border-2 border-charcoal px-4 font-semibold"
                >
                  Done
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
