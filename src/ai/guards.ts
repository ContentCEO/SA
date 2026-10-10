/**
 * Checks in code that don't trust the model (feature plan #17, #42). Pure.
 */

/** Phrases aimed at an AI rather than at the owner. Lower-cased, whitespace-collapsed. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your|system)\b.{0,20}\b(instructions?|prompts?|rules)\b/,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/,
  /\byou are (now )?(an? |the )?(ai|assistant|chat ?bot|language model|llm|gpt|claude)\b/,
  /\b(as|to) (the|an?) (ai|assistant|chat ?bot|language model)\b/,
  /\b(reveal|print|repeat|output) (your|the) (instructions|prompt|system)/,
  /\b(send|forward|email|give|share) (me|us) (the |your )?(owner'?s?|all( of)?( the)?|every|other customers'?)\b.{0,40}\b(emails?|passwords?|logins?|bank|account|card|tokens?|api key|contacts?|customers?|invoices?)\b/,
  /\bnew instructions\b|\bbegin (new )?instructions\b|\[\s*(system|inst)\s*\]|<\|?\s*(im_start|system)\s*\|?>/,
];

/** Long runs of base64-looking text are a classic way to smuggle instructions. */
const BASE64_BLOCK = /[A-Za-z0-9+/]{120,}={0,2}/;
/** Zero-width and bidi-control characters hide text from a human reader. */
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]/g;

export type InjectionCheck = { flagged: boolean; reasons: string[] };

export function injectionCheck(text: string | null | undefined): InjectionCheck {
  const raw = text ?? "";
  const flat = raw.toLowerCase().replace(/\s+/g, " ");
  const reasons: string[] = [];
  if (INSTRUCTION_PATTERNS.some((p) => p.test(flat))) reasons.push("instructions");
  if (BASE64_BLOCK.test(raw.replace(/\s+/g, ""))) reasons.push("encoded");
  if ((raw.match(HIDDEN_CHARS) ?? []).length >= 3) reasons.push("hidden");
  return { flagged: reasons.length > 0, reasons };
}

export const INJECTION_REASON = "This email tries to give instructions to the assistant.";

/**
 * Town, city or county building departments, permit offices and inspectors.
 * The model's signal is the main source; this catches the obvious senders.
 */
export function looksMunicipal(fromAddress: string | null, fromName: string | null): boolean {
  const domain = (fromAddress ?? "").toLowerCase().split("@")[1] ?? "";
  const name = (fromName ?? "").toLowerCase();
  if (domain.endsWith(".gov")) return true;
  // Older US local-government domains: ci.lowell.ma.us, town.acton.ma.us, co.dane.wi.us, townofx.org…
  if (/(^|\.)(ci|co|town|city|county|twp|vil)\.[a-z-]+\.[a-z]{2}\.us$/.test(domain)) return true;
  if (/^(townof|cityof|countyof|villageof)[a-z-]+\./.test(domain)) return true;
  return /\b(building (dept|department|division|inspector|official)|permit(ting)? (office|center|dept|department)|code enforcement|inspectional services)\b/.test(
    name,
  );
}
