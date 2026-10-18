/**
 * Checks in code that don't trust the model (feature plan #17, #42; review round 2). Pure.
 */

/** Phrases aimed at an AI rather than at the owner. Lower-cased, whitespace-collapsed. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your|system)\b.{0,20}\b(instructions?|prompts?|rules)\b/,
  // "Ignore the above and …", "disregard everything above" (review B2). "Ignore the above
  // email/quote" is a person correcting themselves, so a following noun lets it pass.
  /\b(ignore|disregard)\b (all |everything |anything )?(of )?(the |what's |what is )?(above|preceding)\b(?! (emails?|messages?|notes?|one|address|quotes?|prices?|dates?|times?|text|mail|requests?|invoices?|estimates?|numbers?|photos?|pictures?))/,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/,
  /\byou are (now )?(an? |the )?(ai|assistant|chat ?bot|language model|llm|gpt|claude)\b/,
  /\b(as|to) (the|an?) (ai|assistant|chat ?bot|language model)\b/,
  // "Dear AI assistant:", "Hello assistant,", "Note for the automated system" (review B2).
  /\b(dear|hello|hi|hey|attention|attn) (the )?(ai|automated|virtual)( email)? (assistant|system|bot|model|agent|responder)\b/,
  /\b(dear|hello|hi|hey|attention|attn) (ai|assistant|chat ?bot|bot)\b\s*[:,]/,
  /\bnote (for|to) (the )?(ai|assistant|automated system|automated assistant|bot|language model)\b/,
  /\bwhen (drafting|writing|generating|composing) (your|the|a) (reply|response|answer)\b/,
  /\bif (an? |the |any )?(ai|assistant|bot|chat ?bot|language model|automated system)\b.{0,20}\b(is )?(reading|processing|handling|answering|sees|read)\b/,
  /\b(reveal|print|repeat|output) (your|the) (instructions|prompt|system)/,
  /\b(send|forward|email|give|share) (me|us) (the |your )?(owner'?s?|all( of)?( the)?|every|other customers'?)\b.{0,40}\b(emails?|passwords?|logins?|bank|account|card|tokens?|api key|contacts?|customers?|invoices?)\b/,
  /\bnew instructions\b|\bbegin (new )?instructions\b|\[\s*(system|inst)\s*\]|<\|?\s*(im_start|system)\s*\|?>/,
  // Spanish and Portuguese (review B2): "ignora las instrucciones anteriores",
  // "ignore as instruções anteriores", "olvida todo lo anterior".
  /\b(ignora|ignore|ignorar|olvida|olvide|olvidar|esquece|esqueça|esquecer|desconsidera|desconsidere)\b.{0,30}(instrucciones|instruções|instrucoes|indicaciones|reglas|regras)\b/,
  /\b(ignora|olvida|esquece|esqueça|desconsidera)\b (todo|tudo) (lo |o )?(anterior|acima)\b/,
  /\b(instrucciones|instruções|instrucoes) (anteriores|previas|prévias)\b/,
  /\b(eres|você é|voce e|tú eres|tu eres) (ahora |agora )?(un |uma |um )?(asistente|assistente|ia|inteligencia artificial|inteligência artificial)\b/,
  /\b(querido|querida|estimado|estimada|prezado|prezada) (asistente|assistente|ia)\b/,
];

/**
 * Long runs of base64-looking text are a classic way to smuggle instructions. Only runs with
 * no spaces count (base64 has none), and only when they mix upper case, lower case and digits:
 * a long run-on request ("looking for a quote on a 200 amp panel upgrade house was built…")
 * is words with spaces, never one run (review B1). Line breaks are joined first, since encoded
 * blocks are usually wrapped at 76 characters. Links are left out (their tracking tokens are
 * long and random by design).
 */
const BASE64_RUN = /[A-Za-z0-9+/=]{120,}/g;
const looksEncoded = (run: string) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);

/** Zero-width and bidi-control characters hide text from a human reader. */
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]/gu;
/** Unicode "tag" characters: invisible, and able to spell out a whole hidden sentence (B2). */
const TAG_CHARS = /[\u{e0000}-\u{e007f}]/gu;
/**
 * The joiner inside family and job emoji (👨‍👩‍👧‍👦, 👩‍🔧) and the tag sequence of a
 * subdivision flag (🏴 + tags) are how those emoji are built, not hidden text (review B1).
 */
const EMOJI_JOINER =
  /(\p{Extended_Pictographic}|\p{Emoji_Modifier}|️)‍(?=\p{Extended_Pictographic})/gu;
const FLAG_TAGS = /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}/gu;

export type InjectionCheck = { flagged: boolean; reasons: string[] };

export function injectionCheck(text: string | null | undefined): InjectionCheck {
  const raw = text ?? "";
  const flat = raw.toLowerCase().replace(/\s+/g, " ");
  const reasons: string[] = [];
  if (INSTRUCTION_PATTERNS.some((p) => p.test(flat))) reasons.push("instructions");
  // Links are left out: tracking links from lead sites and stores carry long random tokens.
  const joined = raw.replace(/\bhttps?:\/\/\S+/gi, " ").replace(/[\r\n]+/g, "");
  if ([...joined.matchAll(BASE64_RUN)].some((m) => looksEncoded(m[0]))) reasons.push("encoded");
  const visible = raw.replace(FLAG_TAGS, "").replace(EMOJI_JOINER, "$1");
  const hidden =
    (visible.match(HIDDEN_CHARS) ?? []).length + (visible.match(TAG_CHARS) ?? []).length;
  if (hidden >= 3) reasons.push("hidden");
  return { flagged: reasons.length > 0, reasons };
}

/** Check 10 P10: says it's a warning and what to do. */
export const INJECTION_REASON =
  "Careful: this email has hidden instructions aimed at our AI. We won't write a reply. Check who sent it before you click anything.";

/**
 * Payment-change fraud (review A11): "our bank details changed", "wire it to this new
 * account", "pay with gift cards". A real supplier rarely does this by email, and a scammer
 * always does. Always the owner's call, with a plain safety line.
 */
const PAYMENT_CHANGE_PATTERNS: RegExp[] = [
  /\b(bank|banking|account|wire|wiring|ach|remit|remittance|payment) (details|info|information|instructions|account|number|address)\b.{0,40}\b(changed|have changed|has changed|are changing|is changing|updated|have been updated|has been updated|are new|is new)\b/,
  /\b(new|updated|different|changed) (bank|banking|wire|wiring|ach|remit|remittance|payment|routing) (details|info|information|instructions|account|number|address)\b/,
  /\b(changed|switched|moved|updated) (our|my) (bank|banks|banking|bank account|account details|remittance address|remit address|payment details|payment instructions|payment info)\b/,
  /\b(wire|send|transfer|pay|deposit)\b.{0,30}\b(to|into) (this|our|my|the|a) new (account|bank)\b/,
  /\b(do not|don't|dont|stop) (send|sending|pay|paying) (it |payment |payments )?(to|into) (the|our|my) (old|previous|usual) (account|bank|address)\b/,
  /\b(pay|payment|paying|deposit)\b.{0,30}\b(in|with|by|using|via) (itunes |apple |google play |amazon |steam |visa )?gift ?cards?\b/,
  /\b(buy|purchase|get)\b.{0,20}\bgift ?cards?\b.{0,40}\b(pay|payment|invoice|deposit|codes|pins?)\b/,
];

export function looksLikePaymentChange(text: string | null | undefined): boolean {
  const flat = (text ?? "").toLowerCase().replace(/\s+/g, " ");
  return PAYMENT_CHANGE_PATTERNS.some((p) => p.test(flat));
}

export const PAYMENT_CHANGE_REASON =
  "Asks you to pay a new or different account. Call them at a number you already have before paying anything.";

/**
 * Someone smells gas (review TW B4): the one email that can't wait. Top of the queue, needs the
 * owner, and a fixed safety note offered as a draft.
 */
const GAS_SMELL_PATTERNS: RegExp[] = [
  /\b(smell|smells|smelled|smelling|smelt|odor|odour)\b (of |like )?(natural |propane )?gas\b/,
  /\bgas (smell|odor|odour)\b/,
  /\bsmell(s|ed|ing)? (like )?(rotten eggs?|sulfur|sulphur)\b/,
  /\b(huele|olor) a gas\b|\bcheiro de g[aá]s\b/,
];

/** Any mention counts, even "the gas smell is gone now": worth a call either way. */
export function mentionsGasSmell(text: string | null | undefined): boolean {
  const flat = (text ?? "").toLowerCase().replace(/\s+/g, " ");
  return GAS_SMELL_PATTERNS.some((p) => p.test(flat));
}

export const GAS_SMELL_REASON =
  "Says they smell gas. Call them now; a safety note is ready for you to send.";

/**
 * Routine insurance and lien paperwork is not a lawsuit (review TW A1): "the adjuster approved
 * the claim", a home-warranty claim number, a lien waiver for a lender draw, a certificate of
 * insurance. Only the words of a real dispute or threat keep the legal mark: lawyers, courts,
 * suing, a lien filed or threatened against the property, small claims, regulators.
 */
const REAL_LEGAL =
  /\b(attorney|attorneys|lawyer|lawyers|legal action|lawsuit|law suit|sue|suing|sued|court|small claims|litigation|demand letter|cease and desist|better business bureau|bbb|attorney general|consumer protection|93a|licensing board|report you|denied|denial|dispute|disputing|disputed)\b|\b(place|put|file|filed|filing|placing|record|recorded|slap)\b.{0,20}\blien\b|\blien (on|against) (the|my|our|your) (house|home|property)\b/;

export function mentionsRealLegal(text: string | null | undefined): boolean {
  return REAL_LEGAL.test((text ?? "").toLowerCase().replace(/\s+/g, " "));
}

/**
 * Town, city or county building departments, permit offices and inspectors, and every other
 * town office a contractor hears from (review TW A5): wire, plumbing and gas inspectors, fire
 * prevention, boards of health, conservation and historic commissions, and the permit portals
 * that send on a town's behalf. The model's signal is the main source; this catches the
 * obvious senders.
 */
const MUNICIPAL_NAME =
  /\b(building (dept|department|division|inspector|inspectors|inspections?|official|commissioner)|permit(ting)? (office|center|dept|department|desk|portal)|code enforcement|inspectional services|(inspector|inspection) of (wires|wiring|buildings)|wir(e|ing) inspector|electrical inspector|plumbing (and|&) gas inspector|plumbing inspector|gas inspector|fire prevention|fire marshal|board of health|health (dept|department)|conservation (commission|agent|office)|historic(al)? (district )?commission|zoning (board|office|enforcement|administrator)|planning (board|department|office))\b|^(town|city|county|village|borough|township) of [a-z .'-]+$|\b(town|city|county|village|borough|township) of [a-z.'-]+( [a-z.'-]+)? (via|permits?|building|inspections?)\b/;

/** Portals that email permit and inspection notices for a town (OpenGov, ViewPoint…). */
const PERMIT_PORTAL_DOMAINS = [
  "opengov.com",
  "viewpointcloud.com",
  "viewpointcloud.io",
  "citizenserve.com",
  "accela.com",
  "govpilot.com",
  "cloudpermit.com",
];

export function looksMunicipal(fromAddress: string | null, fromName: string | null): boolean {
  const domain = (fromAddress ?? "").toLowerCase().split("@")[1] ?? "";
  const name = (fromName ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (domain.endsWith(".gov")) return true;
  // Older US local-government domains: ci.lowell.ma.us, town.acton.ma.us, co.dane.wi.us,
  // and the plain <town>.<state>.us ones (dracut.ma.us).
  if (/(^|\.)(ci|co|town|city|county|twp|vil)\.[a-z-]+\.[a-z]{2}\.us$/.test(domain)) return true;
  if (/(^|\.)[a-z-]+\.[a-z]{2}\.us$/.test(domain)) return true;
  if (/^(townof|cityof|countyof|villageof)[a-z-]+\./.test(domain)) return true;
  // A permit portal sending as the town: "City of Lowell via OpenGov".
  if (PERMIT_PORTAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return /\b(town|city|county|village|borough|township|permits?|building|inspections?)\b/.test(
      name,
    );
  }
  return MUNICIPAL_NAME.test(name);
}
