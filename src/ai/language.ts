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
