/**
 * Fake Google (consent page, OAuth token / userinfo / revoke, the Gmail REST calls the app
 * makes) and fake Anthropic Messages API, for the local end-to-end tests only (Milestone 11).
 * Started by Playwright (tests/e2e/fakes/main.ts) on 127.0.0.1 only; the app reaches it
 * through the SA_E2E_* base URLs, which src/config/e2e.ts honours only in local e2e mode.
 *
 * Each test registers its own scenario (one fake mailbox). Everything the app asks for is
 * recorded so the spec can assert what happened — but only the method, path, scenario and the
 * few parsed fields the asserts need (grant type, scopes asked for or granted, model and prompt
 * kind, and for a send the From / To / Cc / Bcc / Subject / In-Reply-To / References headers
 * and the thread id). Never a client secret, an authorization code, a token, an Authorization
 * header or a body.
 *
 * The app must use the neutral e2e credentials playwright.config.ts gives it (A3): a token
 * request with any other client id / secret, a consent link with another client id, or a model
 * call with any other API key is refused like real Google / Anthropic would refuse it, and
 * recorded as `wrongClient: true` (never the value), so a lost override fails the spec instead
 * of quietly handing a developer's real Google secret to the fake.
 *
 * Gmail is modelled closely enough for the sync code that matters: drafts are DRAFT-labelled
 * messages in messages.list and history; updating a draft gives it a new message id; sending
 * one returns a new SENT message (the draft and its message go away) that history reports and
 * messages.get answers.
 *
 * Scopes are enforced the way Google does (Davi dropped `gmail.send` on 2026-10-15): the token
 * carries exactly what the owner allowed on the consent page (minus any permission the scenario
 * unticks, plus any an earlier connection granted, which Google adds back because the app asks
 * with `include_granted_scopes=true`), and each Gmail call needs one of the scopes Google's API
 * reference lists for that method (GMAIL_METHOD_SCOPES), or it gets Google's 403 "insufficient
 * authentication scopes", recorded as `insufficientScope: true`. So a journey that sends proves
 * the two scopes the app asks for are enough. A revoke ends the grant: later refreshes get
 * `invalid_grant`.
 *
 * Imports nothing from src/: it runs on its own under tsx.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildInbox,
  fakeOutput,
  outputKindFor,
  refFor,
  type FakeLead,
  type FakeMail,
} from "./outputs";

const AUTH = "https://www.googleapis.com/auth/";
/** What the app must ask for: nothing more, nothing less (src/mailbox/gmail/scopes.ts). */
export const GMAIL_SCOPES = [`${AUTH}gmail.readonly`, `${AUTH}gmail.compose`];
export const CONNECT_SCOPES = ["openid", "email", "profile", ...GMAIL_SCOPES];

/**
 * Which scopes Google accepts for each Gmail call the app makes; any one of them will do.
 * Copied from Google's Gmail API reference (its discovery document,
 * https://gmail.googleapis.com/$discovery/rest?version=v1, revision 20261012, read 2026-10-15).
 * `gmail.send` on its own covers messages.send only: never drafts.send, and no read.
 */
export const GMAIL_METHOD_SCOPES: Readonly<Record<string, readonly string[]>> = (() => {
  const s = (...names: string[]) => ["https://mail.google.com/", ...names.map((n) => AUTH + n)];
  const addonsRead = [
    "gmail.addons.current.message.action",
    "gmail.addons.current.message.metadata",
    "gmail.addons.current.message.readonly",
  ];
  const addonsCompose = "gmail.addons.current.action.compose";
  return {
    "gmail.profile": s("gmail.compose", "gmail.metadata", "gmail.modify", "gmail.readonly"),
    "gmail.messages.list": s("gmail.metadata", "gmail.modify", "gmail.readonly"),
    "gmail.messages.get": s(...addonsRead, "gmail.metadata", "gmail.modify", "gmail.readonly"),
    "gmail.history": s("gmail.metadata", "gmail.modify", "gmail.readonly"),
    "gmail.threads.get": s(...addonsRead, "gmail.metadata", "gmail.modify", "gmail.readonly"),
    "gmail.drafts.create": s(addonsCompose, "gmail.compose", "gmail.modify"),
    "gmail.drafts.get": s("gmail.compose", "gmail.modify", "gmail.readonly"),
    "gmail.drafts.update": s(addonsCompose, "gmail.compose", "gmail.modify"),
    "gmail.drafts.delete": s(addonsCompose, "gmail.compose", "gmail.modify"),
    "gmail.drafts.send": s(addonsCompose, "gmail.compose", "gmail.modify"),
    "gmail.messages.send": s(addonsCompose, "gmail.compose", "gmail.modify", "gmail.send"),
    "gmail.watch": s("gmail.metadata", "gmail.modify", "gmail.readonly"),
  };
})();
const GMAIL_PREFIX = "/google/gmail/v1/users/me";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** The only credentials the fakes accept: playwright.config.ts gives the app exactly these. */
export const E2E_CLIENT_ID = "e2e-client-id";
export const E2E_CLIENT_SECRET = "e2e-client-secret";
export const E2E_ANTHROPIC_KEY = "e2e-fake-key";

/** The parsed headers of an outgoing email: what the spec checks about a send. */
export type SentMail = {
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
};

export type FakeCall = {
  method: string;
  /** The path only, never the query string. */
  path: string;
  /** What it was, e.g. "token", "gmail.drafts.send", "anthropic.messages", "unknown". */
  route: string;
  scenario: string | null;
  grantType?: string;
  /** Anthropic only: the prompt kind the fake recognised, and the model asked for. */
  kind?: string;
  model?: string;
  /** drafts.send and messages.send only. */
  mail?: SentMail;
  /** messages.get with format=metadata: the header names asked for (names only). */
  metadataHeaders?: string[];
  /** Set (never the value) when the app used credentials other than the e2e ones. */
  wrongClient?: true;
  /**
   * Scopes are no secret: for the consent page, what the app asked for; for a token answer,
   * what the token carries.
   */
  scopes?: string[];
  /** A Gmail call the token's scopes don't cover, refused with Google's 403. */
  insufficientScope?: true;
};

/** How the scenario's owner answers Google's consent page. */
export type FakeGrant = {
  /** Gmail permissions the owner unticks (Google's granular consent). */
  untick?: string[];
  /** Scopes an earlier connection already granted, which Google adds back to the new token. */
  earlier?: string[];
};

type Draft = { id: string; messageId: string; threadId: string };

type Scenario = {
  id: string;
  ref: string;
  ownerEmail: string;
  grant: FakeGrant;
  /** Check 47 P1: a Google account with no Gmail (Gmail answers "Mail service not enabled"). */
  noGmail: boolean;
  /** What the owner allowed on the consent page; the authorization code carries it. */
  consented: string[] | null;
  /** What the issued tokens carry: null before the code exchange and after a revoke. */
  granted: string[] | null;
  messages: Map<string, FakeMail>;
  drafts: Map<string, Draft>;
  history: { id: number; added: FakeMail[] }[];
  historyId: number;
  seq: number;
  calls: FakeCall[];
};

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

const gmailError = (status: number, message: string, reason: string) =>
  new HttpError(status, { error: { code: status, message, errors: [{ reason, message }] } });

/** Every JSON answer goes through here: the Anthropic SDK only parses JSON with this header. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, { error: "too_large" });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, { error: "bad_json" });
  }
}

/** RFC 2047 =?UTF-8?B?…?= words, as src/mailbox/mime.ts writes them. */
function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8"),
  );
}

/** A raw message (base64url RFC 2822, as the app builds it) → headers and plain-text body. */
export function parseRaw(raw: string): {
  headers: { name: string; value: string }[];
  body: string;
} {
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const split = mime.indexOf("\r\n\r\n");
  const head = split === -1 ? mime : mime.slice(0, split);
  const rest = split === -1 ? "" : mime.slice(split + 4);
  const headers: { name: string; value: string }[] = [];
  for (const line of head.split(/\r\n(?![ \t])/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    headers.push({ name: line.slice(0, i).trim(), value: decodeWords(line.slice(i + 1).trim()) });
  }
  const encoding = header(headers, "Content-Transfer-Encoding")?.toLowerCase();
  const body =
    encoding === "base64" ? Buffer.from(rest.replace(/\s+/g, ""), "base64").toString("utf8") : rest;
  return { headers, body: body.replace(/\r\n/g, "\n") };
}

function header(headers: { name: string; value: string }[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function sentMail(headers: { name: string; value: string }[], threadId: string | null): SentMail {
  const h = (n: string) => header(headers, n) ?? null;
  return {
    from: h("From"),
    to: h("To"),
    cc: h("Cc"),
    bcc: h("Bcc"),
    subject: h("Subject"),
    inReplyTo: h("In-Reply-To"),
    references: h("References"),
    threadId,
  };
}

/**
 * Gmail's users.messages resource. Metadata reads get headers only — every header when no
 * `metadataHeaders` were named (as real Gmail does), else only the named ones (so a read that
 * forgot to ask for Reply-To doesn't get it); full reads get the body.
 */
export function resource(m: FakeMail, full: boolean, metadataHeaders: string[] = []) {
  const named = metadataHeaders.map((h) => h.toLowerCase());
  const headers =
    full || named.length === 0
      ? m.headers
      : m.headers.filter((h) => named.includes(h.name.toLowerCase()));
  const data = Buffer.from(m.body, "utf8").toString("base64url");
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds,
    snippet: m.body.replace(/\s+/g, " ").slice(0, 100),
    internalDate: String(m.internalDate),
    sizeEstimate: m.body.length,
    payload: {
      mimeType: "text/plain",
      headers,
      body: full ? { data, size: m.body.length } : { size: m.body.length },
    },
  };
}

const ref = (m: FakeMail) => ({ id: m.id, threadId: m.threadId });

export function createFakes() {
  const scenarios = new Map<string, Scenario>();
  /** Calls no scenario could be matched to (e.g. a token another spec seeded). */
  const orphanCalls: FakeCall[] = [];
  let anthropicSeq = 0;

  const record = (scenario: Scenario | undefined, call: Omit<FakeCall, "scenario">) => {
    const full: FakeCall = { ...call, scenario: scenario?.id ?? null };
    (scenario ? scenario.calls : orphanCalls).push(full);
    if (orphanCalls.length > 1000) orphanCalls.shift();
  };

  /** Token values look like at-<scenario id> / rt-<scenario id> / e2e-<scenario id>. */
  const byToken = (value: string | null | undefined, prefix: "at-" | "rt-" | "e2e-") =>
    value?.startsWith(prefix) ? scenarios.get(value.slice(prefix.length)) : undefined;

  /** The scenario whose live access token this is (none once its grant is revoked). */
  const bearer = (req: IncomingMessage) => {
    const auth = req.headers.authorization ?? "";
    const s = byToken(auth.startsWith("Bearer ") ? auth.slice(7) : null, "at-");
    return s?.granted ? s : undefined;
  };

  function addMessage(s: Scenario, m: FakeMail) {
    s.messages.set(m.id, m);
    s.historyId += 1;
    s.history.push({ id: s.historyId, added: [m] });
  }

  function register(input: Record<string, unknown>) {
    const id = typeof input.id === "string" ? input.id : "";
    const ownerEmail = typeof input.ownerEmail === "string" ? input.ownerEmail.toLowerCase() : "";
    if (!/^[0-9a-f-]{36}$/i.test(id) || !ownerEmail.includes("@"))
      throw new HttpError(400, { error: "need id (uuid) and ownerEmail" });
    if (scenarios.has(id)) throw new HttpError(409, { error: "scenario exists" });
    const list = (v: unknown) =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];
    const given = (input.grant ?? {}) as Record<string, unknown>;
    const grant: FakeGrant = { untick: list(given.untick), earlier: list(given.earlier) };
    const lead: FakeLead = input.lead === "form" ? "form" : "direct";
    const r = refFor(id);
    if ([...scenarios.values()].some((s) => s.ref === r))
      throw new HttpError(409, { error: "ref collision" });
    const s: Scenario = {
      id,
      ref: r,
      ownerEmail,
      grant,
      noGmail: input.noGmail === true,
      consented: null,
      granted: null,
      messages: new Map(buildInbox(r, ownerEmail, Date.now(), { lead }).map((m) => [m.id, m])),
      drafts: new Map(),
      history: [],
      historyId: 1000,
      seq: 0,
      calls: [],
    };
    scenarios.set(id, s);
    return { id, ref: r };
  }

  /** The browser's consent page (the spec routes accounts.google.com here). */
  function consent(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const hint = q.get("login_hint")?.toLowerCase();
    const s = hint
      ? [...scenarios.values()].reverse().find((x) => x.ownerEmail === hint)
      : undefined;
    const problems: string[] = [];
    if (!s) problems.push("login_hint is missing or no scenario is registered for it");
    const wrongClient = q.get("client_id") !== E2E_CLIENT_ID;
    if (wrongClient) problems.push("client_id is not the e2e client");
    if (q.get("response_type") !== "code") problems.push("response_type must be code");
    if (q.get("access_type") !== "offline") problems.push("access_type must be offline");
    if (q.get("prompt") !== "consent") problems.push("prompt must be consent");
    const scopes = (q.get("scope") ?? "").split(" ").filter(Boolean);
    if (scopes.length !== CONNECT_SCOPES.length || !CONNECT_SCOPES.every((x) => scopes.includes(x)))
      problems.push(
        "scope must be exactly openid email profile + gmail.readonly + gmail.compose (no gmail.send)",
      );
    const redirect = q.get("redirect_uri") ?? "";
    if (!redirect.endsWith("/api/gmail/callback")) problems.push("redirect_uri is wrong");
    if (!q.get("state")) problems.push("state is missing");
    record(s, {
      method: "GET",
      path: url.pathname,
      route: "consent",
      scopes,
      ...(wrongClient ? { wrongClient: true as const } : {}),
    });
    if (problems.length || !s) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Fake consent refused: ${problems.join("; ")}`);
      return;
    }
    // What Allow grants: what was asked, minus what the owner unticks, plus (with
    // include_granted_scopes=true, as Google does it) whatever an earlier connection granted.
    const kept = scopes.filter((x) => !(s.grant.untick ?? []).includes(x));
    const earlier = q.get("include_granted_scopes") === "true" ? (s.grant.earlier ?? []) : [];
    const consented = [...new Set([...kept, ...earlier])];
    s.consented = consented;
    const back = (params: Record<string, string>) => {
      const u = new URL(redirect);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    };
    const allow = back({ code: `e2e-${s.id}`, state: q.get("state")!, scope: consented.join(" ") });
    const deny = back({ error: "access_denied", state: q.get("state")! });
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in - Google Accounts (fake)</title>
<style>body{font:16px system-ui,sans-serif;margin:16px;max-width:560px}a{display:inline-block;min-height:44px;padding:10px 16px;margin:8px 8px 0 0}li{word-break:break-all}</style></head>
<body><p>Fake Google consent (local tests only)</p>
<h1>Squared Away wants access to your Google Account</h1>
<p>${esc(s.ownerEmail)}</p>
<ul aria-label="Requested access">${scopes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<a href="${deny}">Cancel</a><a href="${allow}">Allow</a></body></html>`);
  }

  async function google(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
    const path = url.pathname;
    if (path === "/google/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grantType = form.get("grant_type") ?? "";
      // Real Google checks the client before the grant.
      if (
        form.get("client_id") !== E2E_CLIENT_ID ||
        form.get("client_secret") !== E2E_CLIENT_SECRET
      ) {
        const s = byToken(form.get("code"), "e2e-") ?? byToken(form.get("refresh_token"), "rt-");
        record(s, { method: "POST", path, route: "token", grantType, wrongClient: true });
        throw new HttpError(401, { error: "invalid_client" });
      }
      if (grantType === "authorization_code") {
        const s = byToken(form.get("code"), "e2e-");
        // Only the consent page's Allow issues a code.
        if (!s?.consented) {
          record(s, { method: "POST", path, route: "token", grantType });
          throw new HttpError(400, { error: "invalid_grant" });
        }
        const granted = s.consented;
        s.granted = granted;
        record(s, { method: "POST", path, route: "token", grantType, scopes: granted });
        sendJson(res, 200, {
          access_token: `at-${s.id}`,
          refresh_token: `rt-${s.id}`,
          expires_in: 3599,
          token_type: "Bearer",
          scope: granted.join(" "),
        });
        return true;
      }
      if (grantType === "refresh_token") {
        const s = byToken(form.get("refresh_token"), "rt-");
        // What real Google says to CI's dummy client about a token it never issued.
        if (!s) {
          record(s, { method: "POST", path, route: "token", grantType });
          throw new HttpError(401, { error: "invalid_client" });
        }
        // Not issued for this scenario yet, or revoked since.
        if (!s.granted) {
          record(s, { method: "POST", path, route: "token", grantType });
          throw new HttpError(400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          });
        }
        record(s, { method: "POST", path, route: "token", grantType, scopes: s.granted });
        sendJson(res, 200, {
          access_token: `at-${s.id}`,
          expires_in: 3599,
          token_type: "Bearer",
          scope: s.granted.join(" "),
        });
        return true;
      }
      record(undefined, { method: "POST", path, route: "token", grantType });
      throw new HttpError(400, { error: "unsupported_grant_type" });
    }
    if (path === "/google/userinfo" && req.method === "GET") {
      const s = bearer(req);
      record(s, { method: "GET", path, route: "userinfo" });
      if (!s) throw new HttpError(401, { error: "invalid_token" });
      sendJson(res, 200, { sub: `sub-${s.ref}`, email: s.ownerEmail, email_verified: true });
      return true;
    }
    if (path === "/google/revoke" && req.method === "POST") {
      const token = new URLSearchParams(await readBody(req)).get("token");
      const s = byToken(token, "rt-") ?? byToken(token, "at-");
      record(s, { method: "POST", path, route: "revoke" });
      if (!s?.granted) throw new HttpError(400, { error: "invalid_token" });
      // Revoking ends the whole grant, earlier scopes included: a reconnect starts afresh.
      s.granted = null;
      s.consented = null;
      s.grant = { ...s.grant, earlier: [] };
      sendJson(res, 200, {});
      return true;
    }
    if (path === GMAIL_PREFIX || path.startsWith(`${GMAIL_PREFIX}/`)) {
      await gmail(req, url, res);
      return true;
    }
    return false;
  }

  async function gmail(req: IncomingMessage, url: URL, res: ServerResponse) {
    const s = bearer(req);
    const rel = url.pathname.slice(GMAIL_PREFIX.length);
    const method = req.method ?? "GET";
    const seg = rel.split("/").filter(Boolean).map(decodeURIComponent);
    const routeName = gmailRouteName(method, seg);
    if (!s) {
      record(undefined, { method, path: url.pathname, route: routeName });
      throw gmailError(401, "Invalid Credentials", "authError");
    }
    const at = (call: Omit<FakeCall, "scenario" | "method" | "path" | "route"> = {}) =>
      record(s, { method, path: url.pathname, route: routeName, ...call });
    const accepted = GMAIL_METHOD_SCOPES[routeName];
    if (accepted && !accepted.some((x) => s.granted?.includes(x))) {
      at({ insufficientScope: true });
      // Google's answer when the token holds none of the scopes the method accepts.
      throw new HttpError(403, {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          errors: [
            {
              message: "Insufficient Permission",
              domain: "global",
              reason: "insufficientPermissions",
            },
          ],
          status: "PERMISSION_DENIED",
        },
      });
    }
    const now = Date.now();
    const q = url.searchParams;

    if (routeName === "gmail.profile") {
      at();
      // What Gmail answers for a Google account that has no Gmail (Check 47 P1).
      if (s.noGmail) throw gmailError(400, "Mail service not enabled", "failedPrecondition");
      return sendJson(res, 200, {
        emailAddress: s.ownerEmail,
        messagesTotal: s.messages.size,
        threadsTotal: new Set([...s.messages.values()].map((m) => m.threadId)).size,
        historyId: String(s.historyId),
      });
    }
    if (routeName === "gmail.messages.list") {
      at();
      const query = q.get("q") ?? "";
      const days = Number(query.match(/newer_than:(\d+)d/)?.[1] ?? 3650);
      const sentOnly = /\bin:sent\b/.test(query);
      // Like Gmail: `in:inbox` / `-in:inbox` (the app lists a window inbox first, Check 25 P1),
      // and Spam / Trash are never listed.
      const inbox = /(^|\s)-in:inbox\b/.test(query)
        ? false
        : /(^|\s)in:inbox\b/.test(query)
          ? true
          : undefined;
      const all = [...s.messages.values()]
        .filter((m) => m.internalDate >= now - days * 86_400_000)
        .filter((m) => !m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH"))
        .filter((m) => !sentOnly || m.labelIds.includes("SENT"))
        .filter((m) => inbox === undefined || m.labelIds.includes("INBOX") === inbox)
        .sort((a, b) => b.internalDate - a.internalDate);
      const max = Math.min(500, Math.max(1, Number(q.get("maxResults") ?? 100)));
      const start = Number(q.get("pageToken") ?? 0) || 0;
      const page = all.slice(start, start + max);
      return sendJson(res, 200, {
        messages: page.map(ref),
        ...(start + max < all.length ? { nextPageToken: String(start + max) } : {}),
        resultSizeEstimate: all.length,
      });
    }
    if (routeName === "gmail.messages.get") {
      const full = (q.get("format") ?? "full") === "full";
      const metadataHeaders = full ? [] : q.getAll("metadataHeaders");
      at(full ? {} : { metadataHeaders });
      const m = s.messages.get(seg[1]!);
      if (!m) throw gmailError(404, "Requested entity was not found.", "notFound");
      return sendJson(res, 200, resource(m, full, metadataHeaders));
    }
    if (routeName === "gmail.history") {
      at();
      const start = Number(q.get("startHistoryId"));
      if (!Number.isFinite(start)) throw gmailError(400, "Invalid startHistoryId", "invalid");
      const records = s.history
        .filter((h) => h.id > start)
        .map((h) => ({
          id: String(h.id),
          messages: h.added.map(ref),
          messagesAdded: h.added.map((m) => ({ message: { ...ref(m), labelIds: m.labelIds } })),
        }));
      return sendJson(res, 200, {
        ...(records.length ? { history: records } : {}),
        historyId: String(s.historyId),
      });
    }
    if (routeName === "gmail.threads.get") {
      at();
      const msgs = [...s.messages.values()].filter((m) => m.threadId === seg[1]);
      if (!msgs.length) throw gmailError(404, "Requested entity was not found.", "notFound");
      return sendJson(res, 200, {
        id: seg[1],
        historyId: String(s.historyId),
        messages: msgs.map((m) => ({ ...ref(m), labelIds: m.labelIds })),
      });
    }
    if (routeName === "gmail.drafts.create" || routeName === "gmail.drafts.update") {
      const body = parseJson(await readBody(req));
      const message = (body.message ?? {}) as { raw?: string; threadId?: string };
      if (!message.raw) throw gmailError(400, "Missing raw", "invalidArgument");
      at();
      const existing = routeName === "gmail.drafts.update" ? s.drafts.get(seg[1]!) : undefined;
      if (routeName === "gmail.drafts.update" && !existing)
        throw gmailError(404, "Requested entity was not found.", "notFound");
      if (existing) s.messages.delete(existing.messageId);
      const parsed = parseRaw(message.raw);
      const n = ++s.seq;
      const threadId = message.threadId ?? existing?.threadId ?? `thr-${s.ref}-new${n}`;
      // Real Gmail: a draft is a DRAFT-labelled message, and every update makes a new message.
      const m: FakeMail = {
        id: `msg-${s.ref}-d${n}`,
        threadId,
        labelIds: ["DRAFT"],
        internalDate: now,
        headers: parsed.headers,
        body: parsed.body,
      };
      addMessage(s, m);
      const draft: Draft = { id: existing?.id ?? `d-${s.ref}-${n}`, messageId: m.id, threadId };
      s.drafts.set(draft.id, draft);
      return sendJson(res, 200, { id: draft.id, message: { ...ref(m), labelIds: m.labelIds } });
    }
    if (routeName === "gmail.drafts.get") {
      at();
      const d = s.drafts.get(seg[1]!);
      const m = d && s.messages.get(d.messageId);
      if (!d || !m) throw gmailError(404, "Requested entity was not found.", "notFound");
      return sendJson(res, 200, { id: d.id, message: resource(m, true) });
    }
    if (routeName === "gmail.drafts.delete") {
      at();
      const d = s.drafts.get(seg[1]!);
      if (!d) throw gmailError(404, "Requested entity was not found.", "notFound");
      s.drafts.delete(d.id);
      s.messages.delete(d.messageId);
      res.writeHead(204);
      return res.end();
    }
    if (routeName === "gmail.drafts.send") {
      const body = parseJson(await readBody(req));
      const d = typeof body.id === "string" ? s.drafts.get(body.id) : undefined;
      const draftMessage = d && s.messages.get(d.messageId);
      if (!d || !draftMessage) {
        at();
        throw gmailError(404, "Requested entity was not found.", "notFound");
      }
      at({ mail: sentMail(draftMessage.headers, d.threadId) });
      // The draft goes; a new SENT message takes its place in the thread.
      s.drafts.delete(d.id);
      s.messages.delete(d.messageId);
      const sent: FakeMail = {
        ...draftMessage,
        id: `msg-${s.ref}-sent${++s.seq}`,
        labelIds: ["SENT"],
        internalDate: now,
      };
      addMessage(s, sent);
      return sendJson(res, 200, { ...ref(sent), labelIds: sent.labelIds });
    }
    if (routeName === "gmail.messages.send") {
      const body = parseJson(await readBody(req));
      if (typeof body.raw !== "string") throw gmailError(400, "Missing raw", "invalidArgument");
      const parsed = parseRaw(body.raw);
      const givenThread = typeof body.threadId === "string" ? body.threadId : null;
      at({ mail: sentMail(parsed.headers, givenThread) });
      const n = ++s.seq;
      const sent: FakeMail = {
        id: `msg-${s.ref}-out${n}`,
        threadId: givenThread ?? `thr-${s.ref}-new${n}`,
        labelIds: ["SENT"],
        internalDate: now,
        headers: parsed.headers,
        body: parsed.body,
      };
      addMessage(s, sent);
      return sendJson(res, 200, { ...ref(sent), labelIds: sent.labelIds });
    }
    if (routeName === "gmail.watch") {
      at();
      return sendJson(res, 200, {
        historyId: String(s.historyId),
        expiration: String(now + 7 * 86_400_000),
      });
    }
    at();
    throw gmailError(404, "Not found (fake)", "notFound");
  }

  function anthropic(
    body: Record<string, unknown>,
    apiKey: string | undefined,
    path: string,
    res: ServerResponse,
  ) {
    const format = (body.output_config as { format?: { schema?: { properties?: object } } })
      ?.format;
    const kind = outputKindFor(Object.keys(format?.schema?.properties ?? {}));
    // Which test this is: the scenario's ref is in the email text the prompt carries.
    const text = JSON.stringify(body.messages ?? "");
    const s = [...scenarios.values()].find((x) => text.includes(x.ref));
    const model = typeof body.model === "string" ? body.model : "unknown";
    const wrongClient = apiKey !== E2E_ANTHROPIC_KEY;
    record(s, {
      method: "POST",
      path,
      route: kind ? "anthropic.messages" : "unknown",
      kind: kind ?? "unknown",
      model,
      ...(wrongClient ? { wrongClient: true as const } : {}),
    });
    const requestId = `req_fake_${++anthropicSeq}`;
    if (wrongClient) {
      return sendJson(
        res,
        401,
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        { "request-id": requestId },
      );
    }
    if (!kind) {
      return sendJson(
        res,
        400,
        {
          type: "error",
          error: { type: "invalid_request_error", message: "The fake knows no such output." },
        },
        { "request-id": requestId },
      );
    }
    sendJson(
      res,
      200,
      {
        id: `msg_fake_${anthropicSeq}`,
        type: "message",
        role: "assistant",
        model,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              fakeOutput(kind, { firstContact: text.includes("FIRST CONTACT") }),
            ),
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 150,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      { "request-id": requestId },
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    try {
      if (path === "/__health") return sendJson(res, 200, { ok: true });
      if (path === "/__scenarios" && req.method === "POST")
        return sendJson(res, 201, register(parseJson(await readBody(req))));
      if (path === "/__calls" && req.method === "GET") {
        const s = scenarios.get(url.searchParams.get("scenario") ?? "");
        return sendJson(res, 200, { calls: s?.calls ?? [] });
      }
      if (path === "/o/oauth2/v2/auth" && req.method === "GET") return consent(url, res);
      if (path === "/anthropic/v1/messages" && req.method === "POST")
        return anthropic(
          parseJson(await readBody(req)),
          typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
          path,
          res,
        );
      if (path.startsWith("/google/") && (await google(req, url, res))) return;
      record(bearer(req), { method: req.method ?? "GET", path, route: "unknown" });
      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, err.body);
      console.error("fake_error", { path, error: err instanceof Error ? err.name : "unknown" });
      sendJson(res, 500, { error: "fake_failed" });
    }
  }

  return { handle, scenarios };
}

function gmailRouteName(method: string, seg: string[]): string {
  const [a, b, c] = seg;
  if (method === "GET" && a === "profile" && !b) return "gmail.profile";
  if (method === "GET" && a === "messages" && !b) return "gmail.messages.list";
  if (method === "GET" && a === "messages" && b && !c) return "gmail.messages.get";
  if (method === "POST" && a === "messages" && b === "send") return "gmail.messages.send";
  if (method === "GET" && a === "history" && !b) return "gmail.history";
  if (method === "GET" && a === "threads" && b && !c) return "gmail.threads.get";
  if (method === "POST" && a === "drafts" && !b) return "gmail.drafts.create";
  if (method === "POST" && a === "drafts" && b === "send") return "gmail.drafts.send";
  if (method === "GET" && a === "drafts" && b && !c) return "gmail.drafts.get";
  if (method === "PUT" && a === "drafts" && b && !c) return "gmail.drafts.update";
  if (method === "DELETE" && a === "drafts" && b && !c) return "gmail.drafts.delete";
  if (method === "POST" && a === "watch" && !b) return "gmail.watch";
  return "unknown";
}

/** Listen on 127.0.0.1 only (port 0 = any free port, for the unit self-test). */
export async function startFakes(port: number): Promise<{ server: Server; url: string }> {
  const fakes = createFakes();
  const server = createServer((req, res) => void fakes.handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const { port: bound } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${bound}` };
}
