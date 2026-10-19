import { isTrade, type Trade } from "@/config/trades";
import type { UsState } from "@/config/us-states";
import { ma } from "./ma";
import type { StatePrompt } from "./types";

/** One file per state that has words of its own; every other state has none. */
export const statePrompts: Partial<Record<UsState, StatePrompt>> = { MA: ma };

/**
 * Check 44 P1 + 45 P2: the state's words for the shop's trades (main and extra), once each, in
 * the trades' order. [] for no state, an unknown state, or a state without a file — so a
 * remodeler in Texas never sees "CSL".
 */
export function stateWordsFor(
  state: string | null | undefined,
  trades: readonly (string | null | undefined)[],
): string[] {
  const prompt = state ? statePrompts[state.trim().toUpperCase() as UsState] : undefined;
  if (!prompt) return [];
  const out: string[] = [];
  const add = (words: readonly string[] | undefined) => {
    for (const w of words ?? []) if (!out.includes(w)) out.push(w);
  };
  add(prompt.vocabulary.all);
  for (const t of trades) if (isTrade(t)) add(prompt.vocabulary[t as Trade]);
  return out;
}

export type { StatePrompt };
