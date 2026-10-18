import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { checkDraft } from "@/ai/draft-checks";
import {
  chooseReplyLanguage,
  detectLanguage,
  languageCardLine,
  languageMismatchFlag,
  looksNonEnglish,
  replyLanguageLine,
} from "@/ai/language";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { drafts, messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { replyLanguagesInput, saveReplyLanguages } from "@/server/profile";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/** Check 43 P8: the reply's language is decided in code, and the card says which and why. */
const SPANISH = "Hola, necesito un plomero para el baño. ¿Cuánto cuesta? Gracias.";
const PORTUGUESE =
  "Olá, preciso de um orçamento para o banheiro. Você pode vir na sexta? Obrigado.";
const ENGLISH = "Hi, can you come look at the leak under my sink this week? Thanks.";

describe("detectLanguage", () => {
  it("short Spanish, Portuguese and English emails", () => {
    expect(detectLanguage(SPANISH)).toBe("es");
    expect(detectLanguage(PORTUGUESE)).toBe("pt");
    expect(detectLanguage(ENGLISH)).toBe("en");
  });
  it("an English email with one Spanish word stays English", () => {
    expect(detectLanguage("Gracias! Can you send the quote for the deck to my email?")).toBe("en");
  });
  it("too short or unclear says nothing", () => {
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage("555-0142 123 Main St")).toBeNull();
  });
});

describe("choosing the reply's language", () => {
  it("the customer's own when it's switched on, else English", () => {
    expect(chooseReplyLanguage("es", ["en", "es"])).toEqual({ customer: "es", reply: "es" });
    expect(chooseReplyLanguage("es", ["en"])).toEqual({ customer: "es", reply: "en" });
    expect(chooseReplyLanguage("pt", ["en", "es"])).toEqual({ customer: "pt", reply: "en" });
    expect(chooseReplyLanguage(null, ["en", "es"])).toEqual({ customer: null, reply: "en" });
    expect(chooseReplyLanguage("en", [])).toEqual({ customer: "en", reply: "en" });
  });
  it("the card's line, only when the customer didn't write in English", () => {
    expect(languageCardLine("es", "es")).toBe("They wrote in Spanish. Reply in Spanish.");
    expect(languageCardLine("es", "en")).toBe(
      "They wrote in Spanish. Reply in English (Spanish is off in Settings).",
    );
    expect(languageCardLine("en", "en")).toBeNull();
    expect(languageCardLine(null, "en")).toBeNull();
    expect(languageCardLine("fr", "en")).toBeNull();
  });
  it("the line for the drafting prompt (for the Prompt versions group)", () => {
    expect(replyLanguageLine({ customer: "es", reply: "es" })).toBe("Reply language: Spanish");
    expect(replyLanguageLine({ customer: "es", reply: "en" })).toBe(
      "Reply language: English (the customer wrote in Spanish; use short, plain sentences)",
    );
    expect(replyLanguageLine({ customer: null, reply: "en" })).toBe("Reply language: English");
  });
  it("Settings: English always, then the switches; anything else ignored", () => {
    expect(replyLanguagesInput.parse([])).toEqual(["en"]);
    expect(replyLanguagesInput.parse(["pt", "es", "fr", "en"])).toEqual(["en", "es", "pt"]);
  });
});

describe("checkDraft's language flag", () => {
  const base = { sourceText: "", doNotPromise: [], phrasesAvoided: [] };
  it("flags a reply in the wrong language, either way", () => {
    const en = checkDraft("Hi Dana, I can come look at it this week. What's the address?", {
      ...base,
      replyLanguage: "es",
    });
    expect(en.flags).toContain("This reply is in English, but you asked for Spanish.");
    expect(en.hits).toContain("language");
    expect(en.confidenceCap).toBeLessThanOrEqual(0.5);
    const es = checkDraft("Hola Dana, puedo ir esta semana. ¿Cuál es la dirección? Gracias.", {
      ...base,
      replyLanguage: "en",
    });
    expect(es.flags).toContain("This reply is in Spanish, but you asked for English.");
  });
  it("no flag when it matches, or when nothing was chosen", () => {
    expect(languageMismatchFlag("Hola, gracias por escribir. Puedo ir el lunes.", "es")).toBeNull();
    const r = checkDraft("Hola, gracias por escribir. Puedo ir el lunes.", base);
    expect(r.hits).not.toContain("language");
  });
});

describe("drafting a reply to a Spanish email", () => {
  const NOW = new Date("2026-10-10T16:00:00Z");
  const reply = (body: string): ModelDraft => ({
    body,
    reason: "Reply.",
    flags: [],
    confidence: 0.95,
    used_facts: [],
  });
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  const deps = () => ({ writerFor: () => writer, now: () => NOW });

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    writer = new FakeWriter();
  });

  async function spanishThread() {
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "t1",
        inInbox: true,
        subject: "Baño",
        category: "quote_request",
        classifiedAt: NOW,
        lastMessageAt: NOW,
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: "t1-m1",
      rfc822MessageId: "<t1-m1@x.com>",
      direction: "in",
      fromAddress: "dana@x.com",
      fromName: "Dana",
      subject: "Baño",
      bodyText: SPANISH,
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    return t!;
  }

  it("Spanish off: written for English, and a Spanish reply is flagged", async () => {
    const t = await spanishThread();
    setModelTransportForTests(
      fakeTransport([reply("Hola Dana, puedo ir el lunes. ¿Cuál es la dirección? Gracias.")])
        .transport,
    );
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    expect(d).toMatchObject({ customerLanguage: "es", replyLanguage: "en" });
    expect(d!.flags).toContain("This reply is in Spanish, but you asked for English.");
  });

  it("Spanish on: written for Spanish, a Spanish reply is clean", async () => {
    await saveReplyLanguages(workspaceId, replyLanguagesInput.parse(["es"]));
    const t = await spanishThread();
    setModelTransportForTests(
      fakeTransport([reply("Hola Dana, puedo ir el lunes. ¿Cuál es la dirección? Gracias.")])
        .transport,
    );
    await createDraftForThread(t.id, { trigger: "auto", ...deps() });
    const [d] = await database.select().from(drafts);
    expect(d).toMatchObject({ customerLanguage: "es", replyLanguage: "es" });
    expect(d!.flags.join(" ")).not.toContain("you asked for");
  });
});

describe("looksNonEnglish (Check 20 P3)", () => {
  it.each([
    "Hola Dana, nos vemos mañana a las 8.",
    "mañana a las 8",
    "el cambio son 1500 dólares",
    "Gracias por todo. ¿Puede venir el jueves?",
    "Necesito que vengan el jueves para ver la cocina y el baño",
    "Olá, obrigado! Você pode vir amanhã de manhã?",
    "Bom dia, preciso de um orçamento para o banheiro.",
    "Necesito que vengan para ver si es posible que lo arreglen con una pieza nueva",
  ])("true for %s", (text) => {
    expect(looksNonEnglish(text)).toBe(true);
  });

  it.each([
    "Hi Mike, José here. Can you come Thursday morning?",
    "Thanks! Meet me at the café on Main St at 10.",
    "Thursday works. Thanks, Dana Peña",
    "Hi, this is João. Could you look at the kitchen faucet?",
    "We're at the De La Cruz place on Calle Real, can you do me a favor and call first?",
    "Attached is my résumé and the photos of the leak.",
    "Sounds good, see you then.",
    "",
  ])("false for %s", (text) => {
    expect(looksNonEnglish(text)).toBe(false);
  });
});
