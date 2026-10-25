/**
 * draft.v9 (wave 2, Prompt versions step 2): Check 23 P11 (the prompt's contradictions), Check
 * 44 P1 + 45 P2 (Massachusetts words only for Massachusetts shops), the inbox notes' lines
 * (reply language, attachments), and the pure helpers behind them.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  ownerFirstName,
  workspaceBlock,
  type WorkspaceContext,
} from "@/ai/prompts/draft.v9";
import { statePrompts, stateWordsFor } from "@/ai/prompts/states";
import { tradePrompts } from "@/ai/prompts/trades";
import { ACTIVE } from "@/ai/prompts/registry";
import { TRADES } from "@/config/trades";
import { US_STATE_CODES } from "@/config/us-states";

const ctx = (over: Partial<WorkspaceContext> = {}): WorkspaceContext => ({
  businessName: "Example Trades Co.",
  trade: "remodeling",
  services: null,
  serviceArea: null,
  hours: null,
  leadTime: null,
  pricingNotes: null,
  paymentTerms: null,
  policies: null,
  signature: null,
  doNotPromise: [],
  neverSay: [],
  seasonalNotes: [],
  voice: null,
  ...over,
});

describe("draft.v9 is the active drafting prompt", () => {
  it("is what the registry names", () => {
    expect(DRAFT_PROMPT_VERSION).toBe("draft.v9");
    expect(ACTIVE.draft).toBe("draft.v9");
  });

  it("carries each Check 23 P11 rule and drops the contradictions", () => {
    for (const rule of [
      "Length: aim for the owner's typical length; if the customer wrote one or two lines, keep it under 60 words.",
      "Tone: the owner's voice always wins. Be calm and polite whatever the customer's tone.",
      "One rule for a fact you don't have",
      "if it depends on seeing the job, ask the customer for what's missing and don't add a price gap",
      'A gap replaces the words for the fact. Write "we can come {{date}}", never "a date {{date}}" or "a time {{time}}".',
      "Answer every question the customer asked, in their order, before asking yours.",
      'Write the reply in the language named on the "Reply language" line',
      "Never say whether a permit is needed, whether something meets code, what a warranty covers, that a fee is waived, or that you'll match a price",
      "never name a worker, a phone number, a link or an email address, unless the business block says it",
      "sign off with the owner's first name from the business block",
      // Check 40 P2.
      "If the customer attached photos, don't ask for photos again",
      // Check 39 P6.
      "Never state rebate amounts, loan terms, tax credits or refrigerant rules as fact",
      // Check 44 P1 + 45 P2.
      "mention a license or registration only when the business block lists it",
      // draft.v8's rules stay.
      "## Who is writing",
      "never deny that an assistant helped",
      "## First contact",
      "Never offer to pay, waive, cover or rebate an insurance deductible.",
    ])
      expect(DRAFT_INSTRUCTIONS, rule).toContain(rule);
    expect(DRAFT_INSTRUCTIONS).not.toContain("net 30");
    expect(DRAFT_INSTRUCTIONS).not.toContain("T&M");
    expect(DRAFT_INSTRUCTIONS).not.toContain('prefer "I\'ll confirm"');
    expect(DRAFT_INSTRUCTIONS).not.toContain("Match the customer's tone");
    expect(DRAFT_INSTRUCTIONS).not.toContain("- Short.");
  });
});

describe("the owner's first name (Check 23 P11)", () => {
  it("reads the voice sign-off first, then the signature", () => {
    expect(ownerFirstName("Thanks, Davi", null)).toBe("Davi");
    expect(ownerFirstName("– Mike", "Ruiz Street Plumbing")).toBe("Mike");
    expect(ownerFirstName("Talk soon", "Mike Ruiz\nRuiz Street Plumbing")).toBe("Mike");
    // Only the first line of a signature is read: a bare sign-off word gives no name.
    expect(ownerFirstName(null, "Best,\nDana Ortiz")).toBeNull();
    expect(ownerFirstName(null, "Dana Ortiz\n555-0100")).toBe("Dana");
    expect(ownerFirstName("Thanks, {{custom:name}}", null)).toBeNull();
    expect(ownerFirstName("thanks", null)).toBeNull();
    expect(ownerFirstName(null, null)).toBeNull();
  });

  it("is in the business block, after the name", () => {
    const block = workspaceBlock(
      ctx({ voice: { ...voice(), signoffStyle: "Cheers, Sam" }, signature: "Sam Lee\nExample" }),
    );
    expect(block).toMatch(/- Name: Example Trades Co\.\n- Owner's first name: Sam\n/);
    expect(workspaceBlock(ctx())).toContain("- Owner's first name: not given");
  });
});

const voice = () => ({
  summary: "Short and direct.",
  greetingStyle: "Hi",
  signoffStyle: null,
  avgLengthWords: 40,
  formality: "casual",
  phrasesUsed: [],
  phrasesAvoided: [],
  examples: [],
});

describe("state words (Check 44 P1 + 45 P2)", () => {
  it("a remodeler with no state, or in Texas, never sees HIC or CSL", () => {
    for (const state of [null, undefined, "TX", "OH", "", "XX"]) {
      const block = workspaceBlock(ctx({ state }));
      expect(block, String(state)).not.toMatch(/\bHIC\b/);
      expect(block, String(state)).not.toMatch(/\bCSL\b/);
      expect(block, String(state)).not.toContain("construction supervisor");
      expect(block, String(state)).not.toContain("Words used in your state");
    }
  });

  it("a Massachusetts remodeler sees both, under the state line, once", () => {
    const block = workspaceBlock(ctx({ state: "MA" }));
    expect(block).toContain(
      "- Words used in your state (understand them; only mention a license or registration the owner listed): home improvement contract (HIC); HIC registration number; construction supervisor license (CSL)",
    );
    expect(block.match(/construction supervisor license \(CSL\)/g)).toHaveLength(1);
    // Lower-case "ma" works; a plumber in MA has no state words of their own.
    expect(workspaceBlock(ctx({ state: "ma" }))).toContain("Words used in your state");
    expect(workspaceBlock(ctx({ state: "MA", trade: "painting" }))).not.toContain(
      "Words used in your state",
    );
    // Step 3: the state's program names for plumbing and HVAC, by name only.
    expect(workspaceBlock(ctx({ state: "MA", trade: "hvac" }))).toContain("Mass Save, HEAT Loan");
    expect(workspaceBlock(ctx({ state: "MA", trade: "hvac" }))).not.toMatch(/\$\s?\d/);
    // A plumber who also does remodeling gets them through the extra trade.
    expect(
      workspaceBlock(ctx({ state: "MA", trade: "plumbing", extraTrades: ["remodeling"] })),
    ).toContain("(CSL)");
  });

  it("the trade file itself is state-neutral", () => {
    const words = tradePrompts.remodeling.vocabulary.join("\n");
    expect(words).not.toMatch(/\bHIC\b|\bCSL\b|construction supervisor/);
    expect(words).toContain("home improvement contract");
    expect(words).toContain("contractor registration or license");
  });

  it("every state file names a real state and only trades from the config", () => {
    for (const [code, prompt] of Object.entries(statePrompts)) {
      expect(US_STATE_CODES as readonly string[]).toContain(code);
      for (const key of Object.keys(prompt!.vocabulary)) {
        expect([...TRADES, "all"], `${code}: ${key}`).toContain(key);
      }
    }
    const files = readdirSync("src/ai/prompts/states").filter(
      (f) => f.endsWith(".ts") && !["index.ts", "types.ts"].includes(f),
    );
    for (const f of files) {
      expect(US_STATE_CODES as readonly string[]).toContain(f.replace(".ts", "").toUpperCase());
      expect(readFileSync(`src/ai/prompts/states/${f}`, "utf8")).toContain("StatePrompt");
    }
    expect(stateWordsFor("MA", ["remodeling", "remodeling"])).toHaveLength(3);
    expect(stateWordsFor("MA", ["blacksmith"])).toEqual([]);
    expect(stateWordsFor(null, ["remodeling"])).toEqual([]);
  });
});

describe("the conversation block (Check 43 P8 + Check 40 P2)", () => {
  const at = new Date("2026-10-16T14:05:00Z");
  it("carries the reply-language line after 'What it is', and the attachments line per email", () => {
    const block = conversationBlock({
      now: at,
      subject: "Fotos",
      category: "quote_request",
      summary: "Luis wants a quote.",
      extracted: {},
      replyLanguage: { customer: "es", reply: "en" },
      messages: [
        {
          from: "Luis",
          direction: "in",
          sentAt: at,
          body: "Adjunto fotos.",
          attachments: { images: 3, pdfs: 0, other: 0 },
        },
        { from: "owner@shop.com", direction: "out", sentAt: at, body: "Thanks." },
      ],
    });
    expect(block).toMatch(
      /What it is: quote_request — Luis wants a quote\.\nReply language: English \(the customer wrote in Spanish; use short, plain sentences\)\nDetails found:/,
    );
    expect(block).toContain("]\nAttached: 3 photos (the assistant can't see them)\nAdjunto fotos.");
    expect(block.match(/Attached:/g)).toHaveLength(1);
    // English by default; Spanish when the owner answers in it.
    expect(
      conversationBlock({
        subject: null,
        category: null,
        summary: null,
        extracted: null,
        messages: [],
      }),
    ).toContain("\nReply language: English\n");
    expect(
      conversationBlock({
        subject: null,
        category: null,
        summary: null,
        extracted: null,
        messages: [],
        replyLanguage: { customer: "es", reply: "es" },
      }),
    ).toContain("\nReply language: Spanish\n");
  });
});
