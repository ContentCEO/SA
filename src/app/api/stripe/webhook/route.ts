import { handleStripeWebhook } from "@/server/billing";

/** Stripe → us. Authenticated by Stripe's signature (not a session), so no CSRF check here. */
export async function POST(req: Request) {
  const body = await req.text();
  const r = await handleStripeWebhook(body, req.headers.get("stripe-signature"));
  return new Response(r.body, { status: r.status });
}
