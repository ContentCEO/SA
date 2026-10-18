import { describe, expect, it } from "vitest";
import { looksNonEnglish } from "@/ai/language";

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
