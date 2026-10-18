import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Plan #47 offer A, static guardrails (design §5.3 "Guardrail", build step 11). Only the owner's
 * Keep / Go back tap may change what a subscription bills; no code may book a plan change for
 * later or put money on a customer's balance; and features read the plan that counts
 * (`effectivePlan`), never the price list directly.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** The argument text of every `<x>.subscriptions.update(` call, with balanced parentheses. */
function updateCalls(text: string): { at: number; args: string }[] {
  const out: { at: number; args: string }[] = [];
  const re = /subscriptions\.update\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push({ at: m.index, args: text.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

/** The function a position sits in (the nearest `function name(` before it). */
function enclosingFunction(text: string, at: number): string | null {
  const before = text.slice(0, at);
  const all = [...before.matchAll(/function (\w+)\s*\(/g)];
  return all.length ? all[all.length - 1]![1]! : null;
}

describe("only the owner's tap changes what a subscription bills", () => {
  it("subscription updates that touch items live only in changePlan (Keep / Go back)", () => {
    const withItems = files.flatMap(({ path, text }) =>
      updateCalls(text)
        .filter((c) => /\bitems\s*:/.test(c.args) || /\bprice\s*:/.test(c.args))
        .map((c) => `${path}:${enclosingFunction(text, c.at)}`),
    );
    expect(withItems).toEqual(["src/server/referrals.ts:changePlan"]);
    const referrals = files.find((f) => f.path === "src/server/referrals.ts")!.text;
    // changePlan is reached only through the two owner-tap entry points.
    const callers = [...referrals.matchAll(/changePlan\("(\w+)"/g)].map((m) => m[1]);
    expect(callers.sort()).toEqual(["go_back", "keep"]);
    for (const name of ["keepFreePlan", "goBackToPaidPlan"])
      expect(referrals).toMatch(new RegExp(`export function ${name}\\(`));
  });

  it("every other subscription update writes discounts only", () => {
    for (const { path, text } of files)
      for (const c of updateCalls(text)) {
        if (enclosingFunction(text, c.at) === "changePlan") continue;
        expect(c.args, `${path}`).toMatch(/\{\s*discounts\s*:/);
      }
  });

  it("nothing books a change for later or puts money on a balance", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/subscriptionSchedules/);
      expect(text, path).not.toMatch(/createBalanceTransaction|balanceTransactions/);
      expect(text, path).not.toMatch(/subscriptions\.create\(/);
    }
  });
});

describe("features read the plan that counts", () => {
  it("only these files index the price list (names, prices, the billed plan)", () => {
    const indexing = files
      .filter(({ text }) => /pricing\.plans\[/.test(text))
      .map(({ path }) => path)
      .sort();
    expect(indexing).toEqual([
      "src/app/(app)/admin/costs/page.tsx",
      "src/app/(app)/billing/page.tsx",
      // Wave 1 (Check 35 P4): the plan cards' lines, by catalog plan id — never a workspace's plan.
      "src/components/marketing/plan-cards.tsx",
      "src/config/pricing.ts",
      "src/server/admin-cost-rules.ts",
      "src/server/billing-rules.ts",
      "src/server/billing.ts",
      "src/server/plan-features.ts",
      "src/server/referral-rules.ts",
      "src/server/referrals.ts",
    ]);
  });

  it("inbox limits and autopilot go through effectivePlan", () => {
    const text = (p: string) => files.find((f) => f.path === p)!.text;
    expect(text("src/server/mailboxes.ts")).toMatch(/effectivePlan\(/);
    expect(text("src/server/autopilot.ts")).toMatch(/effectivePlan\(/);
    expect(text("src/server/workspace-lifecycle.ts")).toMatch(/effectivePlan\(/);
  });
});
