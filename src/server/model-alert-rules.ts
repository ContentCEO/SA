/**
 * Integration (wave 1, Check 48 P3): which part of the app a missing model stops, in the words
 * Davi reads in the alert email and on /admin's System box. Pure: no server-only, no database.
 */
import type { ModelRole } from "@/config/models";

/** The part each model role runs, as the start of a sentence. */
export const MODEL_PART: Record<ModelRole, string> = {
  classify: "Sorting",
  draft: "Drafting",
  voice: "Voice learning",
};

/** What waits while that part is stopped, and what happens once the model is back. */
const WAITING: Record<ModelRole, { waiting: string; after: string }> = {
  classify: {
    waiting: "Owners' mail is waiting.",
    after: "Waiting mail is sorted again",
  },
  draft: {
    waiting: "Owners' replies are waiting to be drafted.",
    after: "Replies are drafted again",
  },
  voice: {
    waiting: "Owners' writing styles are waiting to be learned.",
    after: "Voice learning runs again",
  },
};

export function isModelRole(v: string): v is ModelRole {
  return Object.hasOwn(MODEL_PART, v);
}

/** "Sorting is stopped", "Drafting is stopped" or "Voice learning is stopped". */
export function stoppedHeading(roles: readonly ModelRole[]): string {
  const parts = [...new Set(roles)].map((r) => MODEL_PART[r]);
  if (parts.length === 0) return "System";
  if (parts.length === 1) return `${parts[0]} is stopped`;
  const [first, ...rest] = parts;
  const tail = rest.map((p) => p.toLowerCase());
  return `${[first, ...tail.slice(0, -1)].join(", ")} and ${tail.at(-1)} are stopped`;
}

/** The alert email for one missing model on one role (model name only, no content). */
export function modelDownEmail(role: ModelRole, model: string) {
  const part = MODEL_PART[role];
  return {
    subject: `${part} is stopped: ${model} is not available`,
    lines: [
      `${part} is stopped: ${model} is not available. ${WAITING[role].waiting}`,
      `Nothing is lost. ${WAITING[role].after} once the model answers, or once a stand-in model is approved in src/config/models.ts.`,
    ],
  };
}

/** The /admin System box line for one missing model on one role. */
export function modelDownLine(role: ModelRole, model: string, since: string): string {
  return `${MODEL_PART[role]} stopped since ${since}: model not available (${model}).`;
}
