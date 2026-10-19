/**
 * Check 24 P8 (voice-examples.v1): sample replies rewritten from the owner's stored voice settings
 * only. Three settings; pass = five samples, each opening with the greeting and ending with the
 * sign-off, the avoided phrase absent, no digits except inside placeholders, each within ±50% of
 * the average length.
 */
import { callStructured } from "@/ai/client";
import {
  VOICE_EXAMPLES_INSTRUCTIONS,
  VOICE_EXAMPLES_PROMPT_VERSION,
  voiceExamplesSchema,
  voiceSettingsBlock,
  type VoiceSettings,
} from "@/ai/prompts/voice-examples.v1";

export type VoiceExamplesCase = { id: string; settings: VoiceSettings };

export const VOICE_EXAMPLES_CASES: VoiceExamplesCase[] = [
  {
    id: "ve-casual",
    settings: {
      greetingStyle: "Hey",
      signoffStyle: "Thanks, Sam",
      avgLengthWords: 40,
      formality: "casual",
      phrasesUsed: ["sounds good", "I'll swing by"],
      phrasesAvoided: ["I hope this email finds you well"],
      summary: "You write short, friendly notes and get to the point.",
    },
  },
  {
    id: "ve-formal",
    settings: {
      greetingStyle: "Good morning",
      signoffStyle: "Best regards",
      avgLengthWords: 120,
      formality: "formal",
      phrasesUsed: ["please let me know", "at your convenience"],
      phrasesAvoided: ["no problem"],
      summary: "You write complete, courteous paragraphs and confirm details in full.",
    },
  },
  {
    id: "ve-never-say",
    settings: {
      greetingStyle: "Hi",
      signoffStyle: "Talk soon, Jo",
      avgLengthWords: 60,
      formality: "neutral",
      phrasesUsed: ["happy to help"],
      phrasesAvoided: ["hun", "no worries"],
      summary: "You are warm but plain, and never use pet names.",
    },
  },
];

const strip = (t: string) => t.replace(/\{\{[^}]*\}\}/g, "");

export function voiceExamplesProblems(c: VoiceExamplesCase, examples: string[]): string[] {
  const out: string[] = [];
  if (examples.length !== 5) out.push(`${examples.length} samples`);
  const s = c.settings;
  for (const [i, e] of examples.entries()) {
    const text = e.trim();
    if (s.greetingStyle && !text.toLowerCase().startsWith(s.greetingStyle.toLowerCase()))
      out.push(`sample ${i + 1} doesn't open with the greeting`);
    if (s.signoffStyle && !text.toLowerCase().endsWith(s.signoffStyle.toLowerCase()))
      out.push(`sample ${i + 1} doesn't end with the sign-off`);
    for (const p of s.phrasesAvoided)
      if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))
        out.push(`sample ${i + 1} says "${p}"`);
    if (/\d/.test(strip(text))) out.push(`sample ${i + 1} has a digit outside a placeholder`);
    const words = text.split(/\s+/).length;
    const avg = s.avgLengthWords ?? 60;
    if (words < avg * 0.5 || words > avg * 1.5)
      out.push(`sample ${i + 1} is ${words} words for ${avg}`);
  }
  return out;
}

export async function runVoiceExamplesEvals(workspaceId: string) {
  const problems: Record<string, string[]> = {};
  for (const c of VOICE_EXAMPLES_CASES) {
    const r = await callStructured({
      workspaceId,
      role: "voice",
      promptVersion: VOICE_EXAMPLES_PROMPT_VERSION,
      maxTokens: 1500,
      system: [{ text: VOICE_EXAMPLES_INSTRUCTIONS, cache: false }],
      user: voiceSettingsBlock(c.settings),
      schema: voiceExamplesSchema,
    });
    const found = r ? voiceExamplesProblems(c, r.examples) : ["no usable answer"];
    if (found.length) problems[c.id] = found;
  }
  return {
    voiceExamplesPassRate:
      Math.round(
        ((VOICE_EXAMPLES_CASES.length - Object.keys(problems).length) /
          VOICE_EXAMPLES_CASES.length) *
          1000,
      ) / 1000,
    voiceExamplesProblems: problems,
  };
}
