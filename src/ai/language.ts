/**
 * Check 43 P8: which language a customer wrote in, and which one the reply should be in,
 * decided in code (no model call). Pure. A small stop-word count over English, Spanish and
 * Portuguese; words the languages share ("de", "que", "a") don't count.
 */

export const REPLY_LANGUAGES = ["en", "es", "pt"] as const;
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<ReplyLanguage, string> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
};

export const isReplyLanguage = (v: unknown): v is ReplyLanguage =>
  typeof v === "string" && (REPLY_LANGUAGES as readonly string[]).includes(v);

const STOP_WORDS: Record<ReplyLanguage, ReadonlySet<string>> = {
  en: new Set(
    "the and you your is are to for of it that we can my with have this be at on will would please thanks thank hi hello need i our there what when how about could".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las y en un una con es mi su gracias hola necesito usted puede del al lo pero muy quiero tengo estoy cuánto cuanto cuando dónde donde nuestra nuestro buenas buenos días baño cocina".split(
      " ",
    ),
  ),
  pt: new Set(
    "o os e em um uma com é meu minha seu sua obrigado obrigada olá oi preciso você voce pode mas muito da dos das na não nao gostaria tenho estou quando onde bom dia banheiro cozinha orçamento".split(
      " ",
    ),
  ),
};

/** At least this many stop words before we name a language at all. */
const MIN_HITS = 2;

/**
 * The language of a short email: "en", "es", "pt", or null when it's too short or unclear.
 * An English email with one Spanish word ("Gracias!") stays English.
 */
export function detectLanguage(text: string | null | undefined): ReplyLanguage | null {
  const words = (text ?? "").toLowerCase().match(/\p{L}+/gu) ?? [];
  const hits: Record<ReplyLanguage, number> = { en: 0, es: 0, pt: 0 };
  for (const w of words.slice(0, 400))
    for (const lang of REPLY_LANGUAGES) if (STOP_WORDS[lang].has(w)) hits[lang]++;
  const ranked = REPLY_LANGUAGES.map((l) => [l, hits[l]] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best![1] < MIN_HITS) return null;
  if (best![1] < second![1] * 1.5) return null;
  return best![0];
}

export type LanguageChoice = {
  /** What the customer wrote in (null = we couldn't tell). */
  customer: ReplyLanguage | null;
  /** What the reply is written in. */
  reply: ReplyLanguage;
};

/**
 * The reply's language: the customer's own when the owner answers in it (English always),
 * else English. Unknown → English.
 */
export function chooseReplyLanguage(
  customer: ReplyLanguage | null,
  enabled: readonly string[] | null | undefined,
): LanguageChoice {
  const on = new Set(["en", ...(enabled ?? [])]);
  return { customer, reply: customer && on.has(customer) ? customer : "en" };
}

/**
 * The card's line, only when the customer didn't write in English: "They wrote in Spanish.
 * Reply in Spanish." / "They wrote in Spanish. Reply in English (Spanish is off in Settings)."
 */
export function languageCardLine(
  customer: string | null | undefined,
  reply: string | null | undefined,
): string | null {
  if (!isReplyLanguage(customer) || customer === "en") return null;
  const name = LANGUAGE_NAMES[customer];
  if (reply === customer) return `They wrote in ${name}. Reply in ${name}.`;
  return `They wrote in ${name}. Reply in English (${name} is off in Settings).`;
}

/** checkDraft's flag when the reply isn't in the chosen language. */
export function languageMismatchFlag(body: string, chosen: ReplyLanguage): string | null {
  const wrote = detectLanguage(body);
  if (!wrote || wrote === chosen) return null;
  return `This reply is in ${LANGUAGE_NAMES[wrote]}, but you asked for ${LANGUAGE_NAMES[chosen]}.`;
}

/**
 * The line the Prompt versions group adds to the conversation block (draft.v9 / followup.v5):
 * "Reply language: Spanish" or "Reply language: English (the customer wrote in Spanish; use
 * short, plain sentences)". Kept here so the decision and its wording live in one place.
 */
export function replyLanguageLine(choice: LanguageChoice): string {
  const reply = LANGUAGE_NAMES[choice.reply];
  if (choice.customer && choice.customer !== choice.reply)
    return `Reply language: ${reply} (the customer wrote in ${LANGUAGE_NAMES[choice.customer]}; use short, plain sentences)`;
  return `Reply language: ${reply}`;
}

/**
 * Check 20 P3: is this text Spanish or Portuguese? Every code check behind autopilot (days,
 * times, money words, soft promises) reads English only, so a reply or an email in another
 * language waits for the owner. Pure, no outside library, and tuned so one accent in an
 * English email ("José", "café", "Peña") is no alarm. Never logs or stores the text.
 */

/** Words that only show up in Spanish or Portuguese mail (whole words, lower case). */
const MARKER_WORDS = new Set([
  // Spanish
  "hola",
  "gracias",
  "usted",
  "ustedes",
  "mañana",
  "manana",
  "lunes",
  "martes",
  "miércoles",
  "miercoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
  "buenos",
  "buenas",
  "saludos",
  "estimado",
  "estimada",
  "señor",
  "señora",
  "necesito",
  "quiero",
  "puede",
  "pueden",
  "cuándo",
  "cuando",
  "cuánto",
  "cuanto",
  "dólares",
  "dolares",
  "baño",
  "cocina",
  "también",
  "tambien",
  "hasta",
  "luego",
  // Portuguese
  "obrigado",
  "obrigada",
  "você",
  "voce",
  "vocês",
  "amanhã",
  "amanha",
  "olá",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "preciso",
  "banheiro",
  "cozinha",
  "não",
  "obrigadão",
  "reais",
]);

/** Small words very common in both languages and rare in English. */
const FUNCTION_WORDS = new Set([
  "el",
  "los",
  "las",
  "del",
  "que",
  "y",
  "en",
  "con",
  "por",
  "para",
  "es",
  "son",
  "una",
  "um",
  "uma",
  "com",
  "da",
  "é",
  "está",
  "esta",
  "mi",
  "su",
  "lo",
  "le",
  "se",
  "muy",
  "mas",
  "pero",
  "como",
]);

/** Letters English mail rarely has (one name like "Peña" or "João" is still no alarm). */
const ACCENTED = /[ñãõçáéíóú]/;
const STRONG_MARK = /[¿¡]/;

export function looksNonEnglish(text: string): boolean {
  const lower = text.toLowerCase();
  const words = lower.match(/[\p{L}][\p{L}'-]*/gu) ?? [];
  if (!words.length) return false;
  let markers = 0;
  let functions = 0;
  let accented = 0;
  for (const w of words) {
    if (MARKER_WORDS.has(w)) markers++;
    if (FUNCTION_WORDS.has(w)) functions++;
    if (ACCENTED.test(w)) accented++;
  }
  // "por favor", "bom dia", "buenos días" are two words; count each phrase once more.
  if (/\bpor favor\b|\bbom dia\b|\bboa tarde\b|\bboa noite\b/u.test(lower)) markers++;
  const strong = STRONG_MARK.test(lower) ? 1 : 0;
  const score = markers * 2 + Math.min(accented, 3) + strong * 2;
  if (score >= 3) return true;
  // Longer unaccented text ("Necesito que vengan el jueves para ver la cocina" without the
  // marker words): many small Spanish / Portuguese words.
  return functions >= 4 && functions / words.length >= 0.15;
}
