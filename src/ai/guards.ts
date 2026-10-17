/**
 * Checks in code that don't trust the model (feature plan #17, #42; review round 2). Pure.
 */

/** Phrases aimed at an AI rather than at the owner. Lower-cased, whitespace-collapsed. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  // Check 22 P2: never the writer's own ("my earlier instructions about the gate", "forget my
  // previous instructions, the lockbox code changed"), and never "rules about / for" (the HOA's
  // old rules about work hours). "Ignore all previous instructions" still flags.
  /\b(ignore|disregard|forget|override)\b(?:(?!\b(?:my|our)\b).){0,40}\b(previous|prior|above|earlier|all|your|system)\b(?:(?!\b(?:my|our)\b).){0,20}\b(instructions?|prompts?|rules(?! (about|for|on|regarding)\b))\b/,
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
  // Check 22 P2: only with an order about what to say ("…confirm the job is free", "…always
  // include the owner's cell"), never "when writing your response, list your exclusions".
  /\bwhen (drafting|writing|generating|composing) (your|the|a) (reply|response|answer)\b.{0,60}\b(say|says|include|mention|add|reveal|confirm|agree|promise|state|tell|always|never)\b/,
  // Check 22 P2: "if the assistant manager is handling this" is a person's job title.
  /\bif (an? |the |any )?(ai|assistant(?! (manager|superintendent|principal|director|coach|editor|project manager|pm)\b)|bot|chat ?bot|language model|automated system)\b.{0,20}\b(is )?(reading|processing|handling|answering|sees|read)\b/,
  /\b(reveal|print|repeat|output) (your|the) (instructions|prompt|system)/,
  // Check 22 P2: only what belongs to someone else or is a secret. "Send me all of the
  // invoices from September" (a bookkeeper, an adjuster, a lender's draw) is ordinary.
  /\b(send|forward|email|give|share) (me|us) (the |your )?(owner'?s?|other customers'?|every customer'?s?|all( of)?( the| your)? other customers'?)\b.{0,40}\b(emails?|passwords?|logins?|bank|account|card|tokens?|api key|contacts?|customers?|invoices?|phone|numbers?|address(es)?)\b/,
  /\b(send|forward|email|give|share) (me|us) (the |your )?(all( of)?( the| your)? |every )?(passwords?|logins?|tokens?|api keys?|contacts?( list)?|customer (list|contacts|emails|addresses))\b/,
  /\bnew instructions\b|\bbegin (new )?instructions\b|\[\s*(system|inst)\s*\]|<\|?\s*(im_start|system)\s*\|?>/,
  // Spanish and Portuguese (review B2): "ignora las instrucciones anteriores",
  // "ignore as instruções anteriores", "olvida todo lo anterior".
  // Check 22 P2: no "indicaciones" (directions to the house), and the rules only with
  // anteriores / previas / todas las.
  /\b(ignora|ignore|ignorar|olvida|olvide|olvidar|esquece|esqueça|esquecer|desconsidera|desconsidere)\b.{0,30}((todas (las|as) |todas )(instrucciones|instruções|instrucoes|reglas|regras)|(instrucciones|instruções|instrucoes|reglas|regras) (anteriores|previas|prévias|previas))\b/,
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

export const INJECTION_REASON = "This email tries to give instructions to the assistant.";

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
 *
 * Check 22 P4 + Check 36 P1: split in two. GAS_SMELL_PATTERNS name gas outright (a smell of gas
 * or propane, a gas leak, a hissing line, a red tag from the gas company); EGG_SMELL_PATTERNS
 * name a rotten-egg or sulfur smell, which is a gas smell in the air but usually the water
 * heater's anode rod when it's the water that smells (see `mentionsWaterSmell`).
 */
const GAS_SMELL_PATTERNS: RegExp[] = [
  /\b(smell|smells|smelled|smelling|smelt|odor|odour)\b (of |like )?(natural |propane )?gas\b/,
  /\bgas (smell|odor|odour)\b/,
  // Propane (Check 22 P4, Check 36 P1): "I smell propane", "propane smell in the closet".
  /\b(smell|smells|smelled|smelling|smelt)\b (of |like )?propane\b/,
  /\bpropane (smell|smells|odor|odour|leak|leaks|leaking)\b/,
  // A leak said outright. Not "gas leak detector" / "gas leak test" (an install or a job).
  /\bgas leak(s)?\b(?! (detectors?|tests?|testing|checks?|inspections?|survey))/,
  /\b(leaking|leaks) (natural |propane )?gas\b/,
  /\bgas (line|pipe|piping|meter|valve|hose|connector)\b.{0,30}\b(is |was |keeps )?(hiss|hisses|hissing|leak|leaks|leaking)\b/,
  /\bhiss(es|ing)?\b (sound |noise )?(coming )?(from|near|by|at|behind) the (gas|stove|range|oven|dryer|meter|furnace|boiler|water heater)\b/,
  // Spanish and Portuguese.
  /\b(huele|olía|olia|olor) (como )?a gas\b|\bcheiro de g[aá]s\b|\bfuga de g[aá]s\b|\bvazamento de g[aá]s\b/,
];

/** A rotten-egg or sulfur smell: gas in the air, or (often) smelly well water. */
const EGG_SMELL_PATTERNS: RegExp[] = [
  /\b(smell|smells|smelled|smelling|smelt|odor|odour)\b (of |like )?(rotten eggs?|sulfur|sulphur)\b/,
  /\brotten[- ]eggs? (smell|smells|odor|odour)\b/,
  /\b(sulfur|sulphur) (smell|smells|odor|odour)\b/,
];

/**
 * A gas company red tag ("shut off our meter and red-tagged the water heater"). Only with a gas
 * word: an electrical inspector also "red tags" a failed inspection, which is not a gas leak.
 */
const RED_TAG = /\bred[- ]?tag(ged|s)?\b/;
const GAS_WORD_FOR_TAG = /\b(gas|propane)\b/;

/**
 * Advice printed in a gas utility's footer or a newsletter ("Smell gas? Leave the building and
 * call 911", "If you ever smell gas…", "Gas odor calls are up") is not someone reporting a
 * smell (Check 22 P4). Removed before matching; "it smells like gas near the stove" and "no gas
 * smell anymore" still match.
 */
const GAS_ADVICE: RegExp[] = [
  // A whole sentence that opens with the question: "Smell gas? Leave the building …".
  /(^|[.!?\n]\s*)(do you )?smell (natural )?gas\?[^.!\n]*[.!]?/g,
  /\bsmell (natural )?gas\?/g,
  /\bif you (ever )?(smell|detect|notice) (natural |propane )?gas\b( or [a-z ]{0,40})?/g,
  /\bif you (ever )?(smell|detect|notice) (a |the )?(rotten[- ]egg|sulfur) (smell|odor)\b/g,
  /\bgas (odor|odour|smell|leak) (calls|reports|safety|awareness|tips?)\b/g,
];

const flatten = (text: string | null | undefined) =>
  (text ?? "").toLowerCase().replace(/\s+/g, " ");

function withoutGasAdvice(flat: string): string {
  return GAS_ADVICE.reduce((t, p) => t.replace(p, " "), flat);
}

/** Water words for the sulfur-water exception. A water heater is a gas appliance: not one. */
const WATER_WORD = /\b(water|shower|showers|faucet|faucets|tap|taps)\b/;
/** Any of these anywhere means the smell may well be gas: no water exception. */
const GAS_WORD =
  /\b(gas|propane|meter|stove|range|oven|furnace|boiler|pilot|dryer|in the air|whole house)\b/;

type SmellRead = { gas: boolean; water: boolean };

function readSmell(text: string | null | undefined): SmellRead {
  const flat = withoutGasAdvice(flatten(text));
  if (GAS_SMELL_PATTERNS.some((p) => p.test(flat))) return { gas: true, water: false };
  if (RED_TAG.test(flat) && GAS_WORD_FOR_TAG.test(flat)) return { gas: true, water: false };
  // A water heater is a gas appliance, not water: read it as "heater" from here on.
  const noWaterHeater = flat.replace(/\b(hot )?water (heater|heaters|tank|tanks)\b/g, "heater");
  const eggs = EGG_SMELL_PATTERNS.flatMap((p) => [
    ...noWaterHeater.matchAll(new RegExp(p.source, "g")),
  ]).map((m) => m.index ?? 0);
  if (eggs.length === 0) return { gas: false, water: false };
  // Check 36 P1: "the hot water smells like rotten eggs" (well water, the anode rod) is not a
  // gas leak — but only when EVERY egg/sulfur smell sits next to a water word and nothing in the
  // email names gas or a gas appliance. Narrow on purpose: when in doubt, it's gas.
  // Within 40 characters before or 60 after, and in the same sentence.
  const nearWater = (at: number) => {
    const before =
      noWaterHeater
        .slice(Math.max(0, at - 40), at)
        .split(/[.!?;]/)
        .pop() ?? "";
    const after = noWaterHeater.slice(at, at + 60).split(/[.!?;]/)[0] ?? "";
    return WATER_WORD.test(before + after);
  };
  if (!GAS_WORD.test(noWaterHeater) && eggs.every(nearWater)) return { gas: false, water: true };
  return { gas: true, water: false };
}

/** Any mention counts, even "the gas smell is gone now": worth a call either way. */
export function mentionsGasSmell(text: string | null | undefined): boolean {
  return readSmell(text).gas;
}

/**
 * Check 36 P1: the water smells like rotten eggs or sulfur and nothing says gas — usually the
 * water heater's anode rod with well water. Needs the owner, no safety note, no emergency.
 */
export function mentionsWaterSmell(text: string | null | undefined): boolean {
  return readSmell(text).water;
}

export const GAS_SMELL_REASON =
  "Says they smell gas. Call them now; a safety note is ready for you to send.";
export const WATER_SMELL_REASON =
  "Says the water smells like rotten eggs. Often the water heater's anode rod; call if they also smell it in the air.";

/**
 * Check 22 P4: a carbon monoxide alarm going off. Treated like a gas smell (needs you, top
 * priority, emergency, its own fixed safety note). Only a CO word next to something happening
 * (went off, beeping, a reading, feeling sick) counts: "quote to install carbon monoxide
 * detectors" is a job, and a low-battery chirp is not an alarm.
 */
const CO_TERM =
  /\b(carbon monoxide|co (alarm|alarms|detector|detectors|monitor|sensor|levels?|reading)|co2 (alarm|detector|detectors))\b/g;
const CO_EVENT =
  /\b(went off|going off|goes off|gone off|go off|keeps? going off|sounded|sounding|reading (of |was |is |at )?\d+|reads \d+|\d+ ?ppm|ppm|detected|high levels?|poison(ing|ed)?|headaches?|dizzy|nause(a|ous))\b/;
/** Beeping is an alarm too, unless it's the low-battery chirp. */
const CO_BEEP = /\b(beeping|beeped|beeps|alarming|keeps? (beeping|sounding|alarming))\b/;
const CO_BATTERY = /\b(batter(y|ies)|chirp(s|ing|ed)?)\b/;
const DETECTOR_BY_APPLIANCE =
  /\b(detector|alarm) (is |was |keeps )?(going off|went off|sounding|beeping)\b.{0,40}\b(furnace|boiler|heater|water heater|garage|basement)\b|\b(furnace|boiler|heater)\b.{0,40}\b(detector|alarm) (is |was |keeps )?(going off|went off|sounding|beeping)\b/;

export function mentionsCarbonMonoxide(text: string | null | undefined): boolean {
  const flat = flatten(text);
  for (const m of flat.matchAll(CO_TERM)) {
    const at = m.index ?? 0;
    const around = flat.slice(Math.max(0, at - 60), at + m[0].length + 60);
    if (CO_EVENT.test(around)) return true;
    if (CO_BEEP.test(around) && !CO_BATTERY.test(around)) return true;
  }
  if (DETECTOR_BY_APPLIANCE.test(flat) && !/\bsmoke (detector|alarm)/.test(flat)) return true;
  return false;
}

export const CO_REASON =
  "Says a carbon monoxide alarm went off. Call them now; a safety note is ready for you to send.";

/**
 * Check 37 P1: electrical fire signs, caught in code (the model's own emergency is the main
 * source; this is the backup). Burning smells, smoke / sparks / heat / loud buzzing at an outlet,
 * switch, panel or fixture, a shock, wires down, lights surging. Routine jobs that share the
 * words are taken out first: smoke detectors and alarms, spark plugs, "a burning question", hot
 * tubs, hot water.
 */
const ELECTRICAL_LOOKALIKES =
  /\bsmoke (detectors?|alarms?)\b|\bspark ?plugs?\b|\bburning (question|desire)\b|\bhot tubs?\b|\bhot water\b|\bwarm(er|ing)? drawers?\b/g;
const ELECTRICAL_NOUN =
  "(outlets?|plugs?|receptacles?|switch(es)?|switch ?plates?|panels?|breakers?|breaker box|boxes|box|fixtures?|lights?|ceiling|meter|wires?|wiring|cords?|sockets?|cover ?plates?)";
const NEAR_SIGN =
  "(smok(e|es|ed|ing)|spark(s|ed|ing)?|arc(ing|ed)|(hot|warm) to the touch|buzz(es|ing)? loud(ly)?|loud(ly)? buzz(ing)?|scorch(ed|ing)?|melt(ed|ing))";
const ELECTRICAL_HAZARD_PATTERNS: RegExp[] = [
  // Burning: "a burning smell", "smells like burning plastic", "smells like something electrical
  // is burning".
  /\b(smell|smells|smelled|smelling)\b (of |like )?(something )?(electrical )?(is )?burn(ing|t)\b/,
  /\bburn(ing|t) (smell|smells|odor|odour|plastic|rubber|wire|wires|wiring)\b/,
  new RegExp(`\\b${NEAR_SIGN}\\b.{0,40}\\b${ELECTRICAL_NOUN}\\b`),
  new RegExp(`\\b${ELECTRICAL_NOUN}\\b.{0,40}\\b${NEAR_SIGN}\\b`),
  // Out of the wall itself (not "smoke stained the wall").
  /\b(smok(e|es|ing)|spark(s|ing)?|burning smell)\b.{0,20}\b(from|out of|behind|inside|in) the walls?\b/,
  // A shock from a switch, a tap, a fixture.
  /\b(got|get|getting|gets|gave me) (a |an )?(little |small |big |bad )?shock(ed)?\b|\btingl(e|es|ing) (from|when)\b|\bshocked me\b/,
  // Wires down, the service torn off the house.
  /\bwires? (are |is )?(down|hanging|on the ground|sparking)\b|\b(power|electric|electrical) lines? (are |is )?(down|on the ground)\b/,
  /\b(meter|mast|service|service drop) (box )?(was |got |has been )?(pulled|ripped|torn|came|fell) (off|down|away)\b/,
  // Lights surging.
  /\blights? (keep |are |is )?(going|go|goes|get|getting|flicker(ing)?)( really)? (bright and dim|dim and bright|bright then dim)\b/,
  // Spanish and Portuguese.
  /\bolor a quemado\b|\bchispas\b|\bhumo (del|de la) (enchufe|toma|panel|caja)\b|\bcheiro de queimado\b|\bfa[ií]scas?\b|\btomada quente\b/,
];

export function mentionsElectricalHazard(text: string | null | undefined): boolean {
  const flat = flatten(text).replace(ELECTRICAL_LOOKALIKES, " ");
  return ELECTRICAL_HAZARD_PATTERNS.some((p) => p.test(flat));
}

export const ELECTRICAL_HAZARD_REASON =
  "Sounds like an electrical fire risk. Call them now; a safety note is ready for you to send.";

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
 * Check 22 P3: the legal words that always need the owner, checked in code on the whole email
 * (quoted and forwarded text included: "please read the letter below"). Narrower than
 * REAL_LEGAL: no "denied", "dispute" or "court" alone, and "Sue" is a name, so only the verb
 * forms that can't be one. A power of attorney is not a threat.
 */
const LEGAL_THREAT =
  /\b(attorneys?|lawyers?|law (office|offices|firm)|lawsuits?|law suits?|small claims|demand letter|cease and desist|93a|attorney general|consumer protection|suing|sued|(will|going to|gonna|plan to|intend to|i'll|we'll|we will|i will) sue|sue (you|your|the company|him|her|them))\b|\b(file|filed|filing|place|placed|placing|put) (a |an )?(mechanic'?s )?lien\b|\blien (on|against) (the|my|our|your) (house|home|property)\b/;

export function mentionsLegalThreat(text: string | null | undefined): boolean {
  const flat = (text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bpower of attorney\b/g, " ");
  return LEGAL_THREAT.test(flat);
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
