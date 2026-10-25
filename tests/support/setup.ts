import { beforeEach, vi } from "vitest";

/**
 * Unit tests never use the network. The waitlist's mail-host lookup (Check 47 P3) asks real DNS
 * unless a test passes its own `resolveMx`; on a machine with working DNS that made results
 * depend on who really hosts a test domain's mail (plumb.com is on Microsoft, so CI asked
 * "Invite anyway?" where a sandbox without DNS said "unknown"). Every lookup here fails, so the
 * host is "unknown" unless a test injects one.
 */
vi.mock("node:dns/promises", async (orig) => ({
  ...(await orig<typeof import("node:dns/promises")>()),
  resolveMx: async () => {
    throw Object.assign(new Error("unit tests make no DNS lookups"), { code: "ENOTFOUND" });
  },
}));

/**
 * Check 31 P7: the model client and the jobs log one metadata line per call
 * (`console.info("ai_call", {…})`, `console.info("sync_done", {…})`…). In a passing run that
 * is noise that buries the one failure that matters, so those lines — a first argument that is
 * a snake_case tag — are held per test and printed only if that test fails. Anything else
 * prints as usual. A test that spies on console still sees every call (its spy replaces this).
 */
const TAG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
type Method = "log" | "info";
const original: Record<Method, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
};
let held: [Method, unknown[]][] = [];

for (const method of ["log", "info"] as const) {
  console[method] = (...args: unknown[]) => {
    if (typeof args[0] === "string" && TAG.test(args[0])) held.push([method, args]);
    else original[method](...args);
  };
}

beforeEach(({ onTestFailed }) => {
  const mine: [Method, unknown[]][] = [];
  held = mine;
  onTestFailed(() => {
    for (const [method, args] of mine) original[method](...args);
  });
});

/** The lines held so far for the running test (for the setup's own test). */
export function heldForThisTest(): readonly [Method, unknown[]][] {
  return held;
}
