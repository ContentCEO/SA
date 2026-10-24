/**
 * Plan #49: fake Microsoft (sign-in page, token endpoint and Microsoft Graph) for the local
 * Outlook e2e specs, served by tests/e2e/fakes/server.ts under /microsoft on 127.0.0.1 only. The
 * app reaches it through SA_E2E_MICROSOFT_BASE_URL (src/config/e2e.ts `microsoftEndpoints`), and
 * the browser's Microsoft sign-in page is routed here by the spec (`routeMicrosoftSignIn`).
 *
 * Each Outlook scenario is one Graph stand-in (tests/support/fake-graph.ts) with one customer
 * email in the inbox. The app must use the neutral e2e Azure app id / secret
 * (playwright.config.ts); anything else is refused like Microsoft would. Recorded per scenario:
 * the Graph calls (method, path, whether `Prefer: IdType="ImmutableId"` was missing) and sends
 * (ids, recipients, subject) — never a token, code or body.
 *
 * Imports nothing from src/.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFakeGraph, type FakeGraph } from "../../support/fake-graph";

export const E2E_MS_CLIENT_ID = "e2e-ms-client-id";
export const E2E_MS_CLIENT_SECRET = "e2e-ms-client-secret";
/** What the app must ask for: exactly these (src/mailbox/outlook/scopes.ts). */
export const OUTLOOK_SCOPES = ["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read"];

export const OUTLOOK_LEAD = {
  from: { name: "Dana Ruiz", address: "dana.ruiz@example.com" },
  subject: "Deck repair quote",
  text: "Hi, could you quote a deck repair? It's a 12x16 deck with a few rotten boards. We're at home most afternoons. Thanks, Dana",
};

type Scenario = { id: string; ownerEmail: string; graph: FakeGraph };

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function createMicrosoftFakes() {
  const scenarios = new Map<string, Scenario>();

  function register(body: Record<string, unknown>, host: string) {
    const id = String(body.id ?? "");
    const ownerEmail = String(body.ownerEmail ?? "").toLowerCase();
    if (!id || !ownerEmail) return { status: 400, json: { error: "id and ownerEmail" } };
    const graph = createFakeGraph({
      owner: ownerEmail,
      clientId: E2E_MS_CLIENT_ID,
      clientSecret: E2E_MS_CLIENT_SECRET,
      base: `http://${host}/microsoft/graph/v1.0`,
      noMailbox: body.noMailbox === true,
      grantedScopes: Array.isArray(body.grantedScopes)
        ? (body.grantedScopes as string[])
        : undefined,
    });
    graph.deliver({ ...OUTLOOK_LEAD, at: new Date(Date.now() - 60 * 60_000) });
    // Five earlier replies to other customers in Sent Items, so voice learning has enough.
    for (let i = 1; i <= 5; i++)
      graph.deliver({
        from: { address: ownerEmail },
        subject: `Re: Job ${i}`,
        text: `Hi Pat,\n\nThanks for getting in touch. I can come by and take a look.\n\nMike`,
        at: new Date(Date.now() - (i + 2) * 86_400_000),
        folder: "sentitems",
      });
    scenarios.set(id, { id, ownerEmail, graph });
    return { status: 201, json: { id } };
  }

  /** The fake sign-in page: checks what the app asked for, then offers Accept / Cancel. */
  function signIn(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const hint = q.get("login_hint")?.toLowerCase();
    const s = [...scenarios.values()].reverse().find((x) => x.ownerEmail === hint);
    const problems: string[] = [];
    if (!s) problems.push("login_hint is missing or no Outlook scenario is registered for it");
    if (q.get("client_id") !== E2E_MS_CLIENT_ID) problems.push("client_id is not the e2e app");
    if (q.get("response_type") !== "code") problems.push("response_type must be code");
    if (q.get("prompt") !== "consent" && q.get("prompt") !== "select_account")
      problems.push("prompt must be consent or select_account");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
      problems.push("PKCE S256 is required");
    const scopes = (q.get("scope") ?? "").split(" ").filter(Boolean);
    if (scopes.length !== OUTLOOK_SCOPES.length || !OUTLOOK_SCOPES.every((x) => scopes.includes(x)))
      problems.push("scope must be exactly Mail.ReadWrite Mail.Send offline_access User.Read");
    const redirect = q.get("redirect_uri") ?? "";
    if (!redirect.endsWith("/api/outlook/callback")) problems.push("redirect_uri is wrong");
    if (!q.get("state")) problems.push("state is missing");
    s?.graph.state.calls.push({ method: "GET", path: "/authorize" });
    if (problems.length || !s) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Fake Microsoft sign-in refused: ${problems.join("; ")}`);
      return;
    }
    const code = s.graph.authorize(q.get("code_challenge")!);
    const back = (params: Record<string, string>) => {
      const u = new URL(redirect);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return esc(u.toString());
    };
    const accept = back({ code, state: q.get("state")! });
    const cancel = back({ error: "access_denied", state: q.get("state")! });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Microsoft sign-in (fake)</title>
<style>body{font:16px system-ui,sans-serif;margin:16px;max-width:560px}a{display:inline-block;min-height:44px;padding:10px 16px;margin:8px 8px 0 0}</style></head>
<body><p>Fake Microsoft sign-in (local tests only)</p>
<h1>Permissions requested</h1><p>${esc(s.ownerEmail)}</p>
<ul aria-label="Requested permissions">${scopes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<a href="${cancel}">Cancel</a><a href="${accept}">Accept</a></body></html>`);
  }

  /** Which scenario a token or Graph request belongs to. */
  function owning(form: URLSearchParams | null, bearer: string | undefined) {
    for (const s of scenarios.values()) {
      const st = s.graph.state;
      if (form?.get("code") && st.codes.has(form.get("code")!)) return s;
      if (form?.get("refresh_token") && st.refreshTokens.has(form.get("refresh_token")!)) return s;
      if (bearer && st.accessTokens.has(bearer)) return s;
    }
    return undefined;
  }

  /** Handles /microsoft/* and /__outlook/*; false when the path isn't ours. */
  async function handle(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
    body: () => Promise<string>,
  ): Promise<boolean> {
    const path = url.pathname;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/__outlook/scenarios" && req.method === "POST") {
      const r = register(JSON.parse((await body()) || "{}"), req.headers.host ?? "127.0.0.1");
      json(r.status, r.json);
      return true;
    }
    if (path === "/__outlook/calls" && req.method === "GET") {
      const s = scenarios.get(url.searchParams.get("scenario") ?? "");
      json(200, {
        calls: s?.graph.state.calls ?? [],
        sends: s?.graph.state.sends ?? [],
        drafts: s
          ? [...s.graph.messages.values()]
              .filter((m) => m.isDraft)
              .map((m) => ({ id: m.id, conversationId: m.conversationId }))
          : [],
        subscriptions: s ? s.graph.state.subscriptions.size : 0,
      });
      return true;
    }
    if (path === "/microsoft/authorize" && req.method === "GET") {
      signIn(url, res);
      return true;
    }
    if (!path.startsWith("/microsoft/")) return false;
    const text = await body();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const isToken = path === "/microsoft/token";
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "");
    const s = owning(isToken ? new URLSearchParams(text) : null, bearer);
    if (!s) {
      json(
        isToken ? 400 : 401,
        isToken ? { error: "invalid_grant" } : { error: { code: "InvalidAuthenticationToken" } },
      );
      return true;
    }
    const r = await s.graph.handle(
      req.method ?? "GET",
      `http://${req.headers.host}${req.url}`,
      headers,
      text,
    );
    const out: Record<string, string> = { ...(r.headers ?? {}) };
    if (r.json !== undefined) out["content-type"] = "application/json";
    res.writeHead(r.status, out);
    res.end(
      r.status === 202 || r.status === 204
        ? undefined
        : r.json !== undefined
          ? JSON.stringify(r.json)
          : (r.text ?? ""),
    );
    return true;
  }

  return { handle, scenarios };
}
