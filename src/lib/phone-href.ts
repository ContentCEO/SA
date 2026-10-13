/** "978-201-9763" → "tel:+19782019763" / "sms:+19782019763" (US numbers). */
export function phoneHref(kind: "tel" | "sms", phone: string): string {
  return `${kind}:+1${phone.replace(/\D/g, "")}`;
}
