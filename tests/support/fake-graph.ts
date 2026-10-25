/**
 * Plan #49: a Microsoft Graph + Microsoft identity platform stand-in, for unit tests (as an
 * injected fetch) and the e2e fakes server (tests/e2e/fakes/server.ts serves it under
 * /microsoft). Pure: imports nothing from src/ and touches no network.
 *
 * Modelled closely enough for the Outlook client: well-known folders, immutable ids (a moved or
 * sent message keeps its id), drafts made from base64 MIME, PATCH on drafts only, send = 202
 * with no body (the draft becomes the Sent Items copy), conversation threading by In-Reply-To,
 * `conversationId eq` filters, per-folder delta rounds with `receivedDateTime ge` filters,
 * `@removed` entries and expirable delta tokens, change subscriptions with Graph's 10,080-minute
 * limit, and refresh-token rotation (an old refresh token stops working once rotated, so a
 * client that kept the old one fails). Every request without `Prefer: IdType="ImmutableId"`
 * is recorded as `noImmutableId` so tests can assert there were none.
 */

export const FAKE_GRAPH_SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read"];
export const MAX_SUBSCRIPTION_MINUTES = 10_080;

const FOLDERS = ["inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"] as const;
export type FakeFolder = (typeof FOLDERS)[number];

export type FakeGraphMessage = {
  id: string;
  conversationId: string;
  folder: FakeFolder;
  isDraft: boolean;
  receivedDateTime: string;
  sentDateTime: string;
  subject: string;
  from: { name?: string; address: string };
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  replyTo: { name?: string; address: string }[];
  internetMessageId: string;
  inReplyTo?: string;
  references?: string;
  text: string;
  attachments: { contentType: string; size: number; isInline: boolean }[];
};

export type FakeSend = {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  conversationId: string;
  inReplyTo?: string;
};

export type FakeGraphCall = {
  method: string;
  path: string;
  noImmutableId?: boolean;
  grantType?: string;
  insufficientScope?: boolean;
};

export type FakeSubscription = {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  clientState: string;
  expirationDateTime: string;
};

export type FakeGraphOptions = {
  owner: string;
  clientId?: string;
  clientSecret?: string;
  /** What the owner grants (default every scope we ask for). */
  grantedScopes?: string[];
  /** Mailbox off for the API (a Microsoft account without Exchange Online). */
  noMailbox?: boolean;
  base?: string;
  now?: () => Date;
};

type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T;

function decodeWords(v: string) {
  return v
    .replace(/\r\n[ \t]/g, " ")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_, x: string) =>
      Buffer.from(x, "base64").toString("utf8"),
    );
}

function addresses(v: string | undefined) {
  if (!v) return [];
  return v
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(.*)<([^>]+)>$/);
      return m
        ? {
            name: m[1]!.trim().replace(/^"|"$/g, "") || undefined,
            address: m[2]!.trim().toLowerCase(),
          }
        : { address: p.toLowerCase() };
    });
}

/** Just enough MIME reading for what the app uploads (src/mailbox/mime.ts). */
export function parseMime(mime: string) {
  const split = mime.indexOf("\r\n\r\n");
  const head = mime.slice(0, split).replace(/\r\n[ \t]/g, " ");
  const h = new Map<string, string>();
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) h.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const boundary = h.get("content-type")?.match(/boundary="([^"]+)"/)?.[1];
  let text = "";
  if (boundary) {
    for (const part of mime.slice(split + 4).split(`--${boundary}`)) {
      const p = part.replace(/^\r\n/, "");
      const at = p.indexOf("\r\n\r\n");
      if (at < 0 || !/content-type:\s*text\/plain/i.test(p.slice(0, at))) continue;
      text = Buffer.from(p.slice(at + 4).replace(/\s+/g, ""), "base64").toString("utf8");
    }
  } else {
    text = mime.slice(split + 4);
  }
  return {
    from: addresses(decodeWords(h.get("from") ?? ""))[0],
    to: addresses(decodeWords(h.get("to") ?? "")),
    cc: addresses(decodeWords(h.get("cc") ?? "")),
    bcc: addresses(decodeWords(h.get("bcc") ?? "")),
    subject: decodeWords(h.get("subject") ?? ""),
    inReplyTo: h.get("in-reply-to"),
    references: h.get("references"),
    text: text.replace(/\r\n/g, "\n").trim(),
  };
}

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

export function createFakeGraph(opts: FakeGraphOptions) {
  const base = opts.base ?? "https://graph.microsoft.com/v1.0";
  const now = opts.now ?? (() => new Date());
  const clientId = opts.clientId ?? "ms-id";
  const clientSecret = opts.clientSecret ?? "ms-secret";
  const owner = opts.owner.toLowerCase();
  const folderId = (f: FakeFolder) => `fld-${f}`;
  const messages = new Map<string, FakeGraphMessage>();
  /** Change log for delta: every add to / remove from a folder, in order. */
  const log: { seq: number; folder: FakeFolder; id: string }[] = [];
  let seq = 0;
  let nextId = 1;
  const state = {
    calls: [] as FakeGraphCall[],
    sends: [] as FakeSend[],
    subscriptions: new Map<string, FakeSubscription>(),
    /** Delta tokens issued before this sequence number answer 410. */
    expireDeltaBefore: 0,
    /** Live refresh tokens (rotated on every refresh; the old one stops working). */
    refreshTokens: new Set<string>(),
    accessTokens: new Map<string, string[]>(),
    /** Authorization codes the fake sign-in page issued: code → PKCE challenge. */
    codes: new Map<string, { challenge: string; scopes: string[] }>(),
    grantedScopes: opts.grantedScopes ?? FAKE_GRAPH_SCOPES,
    noMailbox: !!opts.noMailbox,
    /** Make every Graph call answer this status once (e.g. 429). */
    failNext: [] as Reply[],
  };

  function touch(folder: FakeFolder, id: string) {
    log.push({ seq: ++seq, folder, id });
  }
  function put(m: FakeGraphMessage) {
    const before = messages.get(m.id);
    messages.set(m.id, m);
    if (before && before.folder !== m.folder) touch(before.folder, m.id);
    touch(m.folder, m.id);
  }

  /** Mail the customer sends (lands in the inbox). */
  function deliver(m: {
    from: { name?: string; address: string };
    subject: string;
    text: string;
    at?: Date;
    conversationId?: string;
    inReplyTo?: string;
    replyTo?: { name?: string; address: string }[];
    attachments?: FakeGraphMessage["attachments"];
    folder?: FakeFolder;
  }): FakeGraphMessage {
    const id = `AAMk-${nextId++}`;
    const at = (m.at ?? now()).toISOString();
    const msg: FakeGraphMessage = {
      id,
      conversationId: m.conversationId ?? `conv-${id}`,
      folder: m.folder ?? "inbox",
      isDraft: false,
      receivedDateTime: at,
      sentDateTime: at,
      subject: m.subject,
      from: m.from,
      to: [{ address: owner }],
      cc: [],
      replyTo: m.replyTo ?? [],
      internetMessageId: `<${id}@outlook.example>`,
      inReplyTo: m.inReplyTo,
      text: m.text,
      attachments: m.attachments ?? [],
    };
    put(msg);
    return msg;
  }

  function move(id: string, folder: FakeFolder) {
    const m = messages.get(id);
    if (m) put({ ...m, folder });
  }

  function hardDelete(id: string) {
    const m = messages.get(id);
    if (!m) return;
    messages.delete(id);
    touch(m.folder, id);
  }

  const recipient = (a: { name?: string; address: string }) => ({
    emailAddress: { name: a.name ?? a.address, address: a.address },
  });

  function resource(m: FakeGraphMessage, select: string[] | null, textBody: boolean) {
    const headers = [
      { name: "Message-ID", value: m.internetMessageId },
      ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
      ...(m.references ? [{ name: "References", value: m.references }] : []),
    ];
    const full: Record<string, unknown> = {
      id: m.id,
      conversationId: m.conversationId,
      parentFolderId: folderId(m.folder),
      isDraft: m.isDraft,
      receivedDateTime: m.receivedDateTime,
      sentDateTime: m.sentDateTime,
      subject: m.subject,
      from: recipient(m.from),
      toRecipients: m.to.map(recipient),
      ccRecipients: m.cc.map(recipient),
      replyTo: m.replyTo.map(recipient),
      internetMessageId: m.internetMessageId,
      internetMessageHeaders: headers,
      bodyPreview: m.text.slice(0, 255),
      hasAttachments: m.attachments.some((a) => !a.isInline),
      body: textBody
        ? { contentType: "text", content: m.text }
        : { contentType: "html", content: `<p>${m.text}</p>` },
    };
    if (!select) return full;
    return Object.fromEntries(
      Object.entries(full).filter(([k]) => k === "id" || select.includes(k)),
    );
  }

  const folderOf = (raw: string): FakeFolder | null => {
    const f = decodeURIComponent(raw).toLowerCase();
    if ((FOLDERS as readonly string[]).includes(f)) return f as FakeFolder;
    const byId = FOLDERS.find((x) => folderId(x) === f);
    return byId ?? null;
  };

  function list(items: FakeGraphMessage[], url: URL, path: string, textBody: boolean): Reply {
    const select = url.searchParams.get("$select")?.split(",") ?? null;
    const filter = url.searchParams.get("$filter") ?? "";
    let rows = items;
    const since = filter.match(/receivedDateTime ge (\S+)/)?.[1];
    if (since) rows = rows.filter((m) => m.receivedDateTime >= since);
    const conv = filter.match(/conversationId eq '((?:[^']|'')*)'/)?.[1];
    if (conv !== undefined)
      rows = rows.filter((m) => m.conversationId === conv.replace(/''/g, "'"));
    rows = rows.slice().sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
    const top = Number(url.searchParams.get("$top") ?? 10);
    const skip = Number(url.searchParams.get("$skip") ?? 0);
    const page = rows.slice(skip, skip + top);
    const next = new URL(`${base}${path}`);
    url.searchParams.forEach((v, k) => k !== "$skip" && next.searchParams.set(k, v));
    next.searchParams.set("$skip", String(skip + top));
    return {
      status: 200,
      json: {
        value: page.map((m) => resource(m, select, textBody)),
        ...(skip + top < rows.length ? { "@odata.nextLink": next.toString() } : {}),
      },
    };
  }

  function delta(folder: FakeFolder, url: URL, maxPage: number): Reply {
    type Tok = {
      since: string | null;
      after: number;
      until: number;
      offset: number;
      select: string;
    };
    const skipToken = url.searchParams.get("$skiptoken");
    const deltaToken = url.searchParams.get("$deltatoken");
    let tok: Tok;
    if (skipToken) tok = unb64<Tok>(skipToken);
    else if (deltaToken) {
      const d = unb64<{ since: string | null; at: number; select: string }>(deltaToken);
      if (d.at < state.expireDeltaBefore)
        return { status: 410, json: { error: { code: "SyncStateNotFound" } } };
      tok = { since: d.since, after: d.at, until: seq, offset: 0, select: d.select };
    } else {
      const since =
        url.searchParams.get("$filter")?.match(/receivedDateTime ge (\S+)/)?.[1] ?? null;
      tok = {
        since,
        after: -1,
        until: seq,
        offset: 0,
        select: url.searchParams.get("$select") ?? "id",
      };
    }
    const select = tok.select.split(",");
    let entries: unknown[];
    if (tok.after < 0) {
      // First round: everything in the folder now.
      entries = [...messages.values()]
        .filter((m) => m.folder === folder && (!tok.since || m.receivedDateTime >= tok.since))
        .map((m) => resource(m, select, false));
    } else {
      const ids = [
        ...new Set(
          log
            .filter((e) => e.folder === folder && e.seq > tok.after && e.seq <= tok.until)
            .map((e) => e.id),
        ),
      ];
      entries = ids.flatMap((id) => {
        const m = messages.get(id);
        if (m && m.folder === folder)
          return !tok.since || m.receivedDateTime >= tok.since ? [resource(m, select, false)] : [];
        return [{ id, "@removed": { reason: "deleted" } }];
      });
    }
    const page = entries.slice(tok.offset, tok.offset + maxPage);
    const link = new URL(`${base}/me/mailFolders/${folder}/messages/delta`);
    if (tok.offset + maxPage < entries.length) {
      link.searchParams.set("$skiptoken", b64({ ...tok, offset: tok.offset + maxPage }));
      return { status: 200, json: { value: page, "@odata.nextLink": link.toString() } };
    }
    link.searchParams.set(
      "$deltatoken",
      b64({ since: tok.since, at: tok.until, select: tok.select }),
    );
    return { status: 200, json: { value: page, "@odata.deltaLink": link.toString() } };
  }

  function issueTokens(scopes: string[]) {
    const access = `at-${nextId++}`;
    const refresh = `rt-${nextId++}`;
    state.accessTokens.set(access, scopes);
    state.refreshTokens.add(refresh);
    return { access, refresh };
  }

  /** The fake sign-in page's answer: a code for this PKCE challenge. */
  function authorize(challenge: string): string {
    const code = `code-${nextId++}`;
    state.codes.set(code, { challenge, scopes: state.grantedScopes });
    return code;
  }

  /** Give a test a working refresh token without the sign-in dance. */
  function grantRefreshToken(scopes = state.grantedScopes): string {
    return issueTokens(scopes).refresh;
  }

  async function sha256b64url(v: string) {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(v).digest("base64url");
  }

  async function token(form: URLSearchParams): Promise<Reply> {
    const grant = form.get("grant_type") ?? "";
    state.calls.push({ method: "POST", path: "/token", grantType: grant });
    if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret)
      return { status: 401, json: { error: "invalid_client" } };
    if (grant === "authorization_code") {
      const c = state.codes.get(form.get("code") ?? "");
      if (!c) return { status: 400, json: { error: "invalid_grant" } };
      state.codes.delete(form.get("code")!);
      if ((await sha256b64url(form.get("code_verifier") ?? "")) !== c.challenge)
        return { status: 400, json: { error: "invalid_grant" } };
      const t = issueTokens(c.scopes);
      return {
        status: 200,
        json: {
          access_token: t.access,
          refresh_token: t.refresh,
          scope: c.scopes.map((s) => `https://graph.microsoft.com/${s}`).join(" "),
          token_type: "Bearer",
          expires_in: 3600,
        },
      };
    }
    if (grant === "refresh_token") {
      const old = form.get("refresh_token") ?? "";
      if (!state.refreshTokens.has(old)) return { status: 400, json: { error: "invalid_grant" } };
      state.refreshTokens.delete(old);
      const t = issueTokens(state.grantedScopes);
      return {
        status: 200,
        json: { access_token: t.access, refresh_token: t.refresh, expires_in: 3600 },
      };
    }
    return { status: 400, json: { error: "unsupported_grant_type" } };
  }

  function needScope(scopes: string[], need: string): boolean {
    return scopes.includes(need) || (need === "Mail.Read" && scopes.includes("Mail.ReadWrite"));
  }

  async function graph(method: string, url: URL, headers: Headers, body: string): Promise<Reply> {
    const path = url.pathname.slice(new URL(base).pathname.length);
    const call: FakeGraphCall = { method, path };
    state.calls.push(call);
    if (!/IdType="ImmutableId"/.test(headers.get("prefer") ?? "")) call.noImmutableId = true;
    const scopes = state.accessTokens.get(
      (headers.get("authorization") ?? "").replace(/^Bearer /, ""),
    );
    if (!scopes) return { status: 401, json: { error: { code: "InvalidAuthenticationToken" } } };
    const fail = state.failNext.shift();
    if (fail) return fail;
    const denied = (need: string): Reply | null => {
      if (needScope(scopes, need)) return null;
      call.insufficientScope = true;
      return { status: 403, json: { error: { code: "ErrorAccessDenied" } } };
    };
    const textBody = /outlook\.body-content-type="text"/.test(headers.get("prefer") ?? "");
    const maxPage = Number(
      (headers.get("prefer") ?? "").match(/odata\.maxpagesize=(\d+)/)?.[1] ?? 10,
    );
    let m: RegExpMatchArray | null;

    if (path === "/me" && method === "GET")
      return denied("User.Read") ?? { status: 200, json: { mail: null, userPrincipalName: owner } };
    if (path.startsWith("/me/") && state.noMailbox)
      return { status: 404, json: { error: { code: "MailboxNotEnabledForRESTAPI" } } };
    if ((m = path.match(/^\/me\/mailFolders\/([^/]+)$/)) && method === "GET") {
      const f = folderOf(m[1]!);
      return f ? { status: 200, json: { id: folderId(f) } } : { status: 404, json: {} };
    }
    if ((m = path.match(/^\/me\/mailFolders\/([^/]+)\/messages\/delta$/)) && method === "GET") {
      const f = folderOf(m[1]!);
      if (!f) return { status: 404, json: {} };
      return denied("Mail.Read") ?? delta(f, url, maxPage);
    }
    if ((m = path.match(/^\/me\/mailFolders\/([^/]+)\/messages$/)) && method === "GET") {
      const f = folderOf(m[1]!);
      if (!f) return { status: 404, json: {} };
      return (
        denied("Mail.Read") ??
        list(
          [...messages.values()].filter((x) => x.folder === f),
          url,
          path,
          textBody,
        )
      );
    }
    if (path === "/me/messages" && method === "GET")
      return denied("Mail.Read") ?? list([...messages.values()], url, path, textBody);
    if (path === "/me/messages" && method === "POST") {
      const no = denied("Mail.ReadWrite");
      if (no) return no;
      if (!/^text\/plain/.test(headers.get("content-type") ?? ""))
        return { status: 415, json: { error: { code: "UnsupportedMediaType" } } };
      const mime = parseMime(Buffer.from(body.trim(), "base64").toString("utf8"));
      const parent = mime.inReplyTo
        ? [...messages.values()].find((x) => x.internetMessageId === mime.inReplyTo)
        : undefined;
      const id = `AAMk-${nextId++}`;
      const at = now().toISOString();
      const draft: FakeGraphMessage = {
        id,
        conversationId: parent?.conversationId ?? `conv-${id}`,
        folder: "drafts",
        isDraft: true,
        receivedDateTime: at,
        sentDateTime: at,
        subject: mime.subject,
        from: { address: owner },
        to: mime.to,
        cc: mime.cc,
        replyTo: [],
        internetMessageId: `<${id}@outlook.example>`,
        inReplyTo: mime.inReplyTo,
        references: mime.references,
        text: mime.text,
        attachments: [],
      };
      put(draft);
      return { status: 201, json: resource(draft, null, false) };
    }
    if ((m = path.match(/^\/me\/messages\/([^/]+)\/attachments$/)) && method === "GET") {
      const msg = messages.get(decodeURIComponent(m[1]!));
      return msg ? { status: 200, json: { value: msg.attachments } } : { status: 404, json: {} };
    }
    if ((m = path.match(/^\/me\/messages\/([^/]+)\/send$/)) && method === "POST") {
      const no = denied("Mail.Send");
      if (no) return no;
      const msg = messages.get(decodeURIComponent(m[1]!));
      if (!msg) return { status: 404, json: { error: { code: "ErrorItemNotFound" } } };
      if (!msg.isDraft) return { status: 400, json: { error: { code: "ErrorInvalidRequest" } } };
      const at = now().toISOString();
      put({ ...msg, isDraft: false, folder: "sentitems", sentDateTime: at, receivedDateTime: at });
      state.sends.push({
        id: msg.id,
        to: msg.to.map((a) => a.address),
        cc: msg.cc.map((a) => a.address),
        subject: msg.subject,
        conversationId: msg.conversationId,
        inReplyTo: msg.inReplyTo,
      });
      return { status: 202 };
    }
    if ((m = path.match(/^\/me\/messages\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const msg = messages.get(id);
      if (method === "GET") {
        if (denied("Mail.Read")) return denied("Mail.Read")!;
        const select = url.searchParams.get("$select")?.split(",") ?? null;
        return msg
          ? { status: 200, json: resource(msg, select, textBody) }
          : { status: 404, json: {} };
      }
      const no = denied("Mail.ReadWrite");
      if (no) return no;
      if (!msg) return { status: 404, json: { error: { code: "ErrorItemNotFound" } } };
      if (method === "DELETE") {
        hardDelete(id);
        return { status: 204 };
      }
      if (method === "PATCH") {
        if (!msg.isDraft) return { status: 400, json: { error: { code: "ErrorInvalidRequest" } } };
        const p = JSON.parse(body) as {
          subject?: string;
          body?: { contentType?: string; content?: string };
          toRecipients?: { emailAddress: { address: string; name?: string } }[];
          ccRecipients?: { emailAddress: { address: string; name?: string } }[];
        };
        const next = { ...msg };
        if (p.subject !== undefined) next.subject = p.subject;
        if (p.body?.content !== undefined)
          next.text = p.body.contentType === "html" ? stripHtml(p.body.content) : p.body.content;
        if (p.toRecipients) next.to = p.toRecipients.map((r) => ({ ...r.emailAddress }));
        if (p.ccRecipients) next.cc = p.ccRecipients.map((r) => ({ ...r.emailAddress }));
        put(next);
        return { status: 200, json: resource(next, null, false) };
      }
    }
    if (path === "/subscriptions" && method === "POST") {
      const p = JSON.parse(body) as Omit<FakeSubscription, "id">;
      const max = now().getTime() + MAX_SUBSCRIPTION_MINUTES * 60_000;
      if (Date.parse(p.expirationDateTime) > max)
        return { status: 400, json: { error: { code: "InvalidRequest" } } };
      const sub = { ...p, id: `sub-${nextId++}` };
      state.subscriptions.set(sub.id, sub);
      return { status: 201, json: { ...sub, clientState: undefined } };
    }
    if ((m = path.match(/^\/subscriptions\/([^/]+)$/))) {
      const sub = state.subscriptions.get(decodeURIComponent(m[1]!));
      if (!sub) return { status: 404, json: { error: { code: "ResourceNotFound" } } };
      if (method === "DELETE") {
        state.subscriptions.delete(sub.id);
        return { status: 204 };
      }
      if (method === "PATCH") {
        const p = JSON.parse(body) as { expirationDateTime: string };
        if (Date.parse(p.expirationDateTime) > now().getTime() + MAX_SUBSCRIPTION_MINUTES * 60_000)
          return { status: 400, json: { error: { code: "InvalidRequest" } } };
        sub.expirationDateTime = p.expirationDateTime;
        return { status: 200, json: { ...sub, clientState: undefined } };
      }
    }
    return { status: 404, json: { error: { code: "NotImplementedInFake" } } };
  }

  /** One request, as either fetch (unit tests) or the e2e server sees it. */
  async function handle(
    method: string,
    rawUrl: string,
    headers: Headers,
    body: string,
  ): Promise<Reply> {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("/oauth2/v2.0/token") || url.pathname.endsWith("/token"))
      if (!url.pathname.startsWith(new URL(base).pathname + "/"))
        return token(new URLSearchParams(body));
    return graph(method, url, headers, body);
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const r = await handle(init?.method ?? "GET", url, headers, String(init?.body ?? ""));
    const resHeaders = new Headers(r.headers);
    if (r.json !== undefined) resHeaders.set("content-type", "application/json");
    const noBody = r.status === 202 || r.status === 204;
    return new Response(
      noBody ? null : r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ""),
      {
        status: r.status,
        headers: resHeaders,
      },
    );
  }) as typeof fetch;

  return {
    state,
    messages,
    folderId,
    deliver,
    move,
    hardDelete,
    authorize,
    grantRefreshToken,
    handle,
    fetch: fetchImpl,
    /** Make every delta link issued so far answer 410. */
    expireDeltaTokens() {
      state.expireDeltaBefore = seq + 1;
    },
  };
}

export type FakeGraph = ReturnType<typeof createFakeGraph>;
