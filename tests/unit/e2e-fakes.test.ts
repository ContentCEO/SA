import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyOwnerRules } from "@/ai/classify";
import { checkDraft, REGENERATE_ON } from "@/ai/draft-checks";
import { injectionCheck, looksMunicipal } from "@/ai/guards";
import { classificationSchema } from "@/ai/prompts/classify.v4";
import { draftSchema } from "@/ai/prompts/draft.v6";
import { replyDraftSchema } from "@/ai/prompts/draft.v7";
import { editToneSchema } from "@/ai/prompts/edit-tone.v1";
import { voiceSchema } from "@/ai/prompts/voice.v2";
import { anthropicClientOptions } from "@/config/e2e";
import { models } from "@/config/models";
import { MailboxAuthError, MissingScopesError } from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { createGmailConnector } from "@/mailbox/gmail/connector";
import { ALL_CONNECT_SCOPES, GMAIL_SCOPES } from "@/mailbox/gmail/scopes";
import { buildReplyMime, replySubject, sameText, toGmailRaw } from "@/mailbox/mime";
import {
  buildInbox,
  FAKE_CLASSIFICATION,
  FAKE_DRAFT,
  FAKE_EDIT_TONE,
  FAKE_FIRST_REPLY,
  FAKE_VOICE,
  fakeCustomer,
  fakeOutput,
  FORM_ROBOT,
  outputKindFor,
  refFor,
} from "../e2e/fakes/outputs";
import { pickReplyTo } from "@/server/reply-address-rules";
import {
  CONNECT_SCOPES as FAKE_CONNECT_SCOPES,
  GMAIL_METHOD_SCOPES,
  GMAIL_SCOPES as FAKE_GMAIL_SCOPES,
  resource,
  startFakes,
  type FakeCall,
  type FakeGrant,
} from "../e2e/fakes/server";

/**
 * Milestone 11 S2: the e2e fakes answer the way the app needs, so the end-to-end spec
 * (tests/e2e/full-flow.spec.ts) goes connect → sort → draft → send without a model failure, a
 * regenerate, a needs-you or a sync surprise — and a prompt or schema change that would break
 * that fails here, in a second, instead of in a slow browser run.
 */

describe("the fake model outputs", () => {
  it("parse with the real prompt schemas", () => {
    expect(classificationSchema.parse(FAKE_CLASSIFICATION)).toEqual(FAKE_CLASSIFICATION);
    expect(draftSchema.parse(FAKE_DRAFT)).toEqual(FAKE_DRAFT);
    // draft.v7: an ordinary reply reads as "not_first"; a first contact names its shape.
    expect(replyDraftSchema.parse(FAKE_DRAFT)).toEqual({ ...FAKE_DRAFT, opening: "not_first" });
    expect(replyDraftSchema.parse(FAKE_FIRST_REPLY)).toEqual(FAKE_FIRST_REPLY);
    expect(fakeOutput("draft", { firstContact: true })).toBe(FAKE_FIRST_REPLY);
    expect(fakeOutput("draft")).toBe(FAKE_DRAFT);
    expect(voiceSchema.parse(FAKE_VOICE)).toEqual(FAKE_VOICE);
    expect(editToneSchema.parse(FAKE_EDIT_TONE)).toEqual(FAKE_EDIT_TONE);
  });

  it("each request is told apart by its output schema, as the fake does it", () => {
    const keys = (s: Parameters<typeof zodOutputFormat>[0]) =>
      Object.keys((zodOutputFormat(s).schema as { properties: object }).properties);
    expect(outputKindFor(keys(classificationSchema))).toBe("classify");
    expect(outputKindFor(keys(draftSchema))).toBe("draft");
    expect(outputKindFor(keys(voiceSchema))).toBe("voice");
    expect(outputKindFor(keys(editToneSchema))).toBe("edit_tone");
    expect(outputKindFor(["something_else"])).toBeNull();
  });

  it("the draft passes every check against the customer's email: no flag, no regenerate", () => {
    const c = fakeCustomer(refFor("0f6c2a1e-1111-4222-8333-944455556666"));
    const result = checkDraft(FAKE_DRAFT.body, {
      sourceText: `${c.subject}\n${c.body}\nRuiz Street Plumbing. Water heaters, leaks, drains and repipes.`,
      doNotPromise: [],
      phrasesAvoided: [...FAKE_VOICE.phrases_avoided],
      neverSay: [],
    });
    expect(result.flags).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.hits.some((h) => REGENERATE_ON.includes(h))).toBe(false);
    expect(FAKE_DRAFT.body).not.toMatch(/\{\{|\}\}/);
  });

  it("the classification is not forced to needs-you, so the thread auto-drafts", () => {
    const c = fakeCustomer(refFor("0f6c2a1e-1111-4222-8333-944455556666"));
    // A first-time sender, the default $2,500 threshold, no VIPs: exactly the e2e owner.
    const rules = applyOwnerRules(classificationSchema.parse(FAKE_CLASSIFICATION), {
      firstTimeSender: true,
      senderIsVip: false,
      amountThresholdDollars: 2500,
      injection: injectionCheck(c.body).flagged,
    });
    expect(rules.needsOwner).toBe(false);
    expect(looksMunicipal(c.email, c.name)).toBe(false);
  });

  it("a website form lead: the robot in From, Dana in Reply-To, the ref in the text; it still auto-drafts", () => {
    const ref = refFor("0f6c2a1e-1111-4222-8333-944455556666");
    const c = fakeCustomer(ref, "form");
    const [lead] = buildInbox(ref, "owner@example.com", Date.now(), { lead: "form" });
    const h = (n: string) => lead!.headers.find((x) => x.name === n)?.value;
    expect(h("From")).toBe(`${FORM_ROBOT.name} <${FORM_ROBOT.email}>`);
    expect(h("Reply-To")).toBe(`Dana Ruiz <${c.email}>`);
    expect(lead!.body).toContain(`Ref ${ref}`);
    expect(
      pickReplyTo(h("Reply-To"), { from: FORM_ROBOT.email, self: ["owner@example.com"] }),
    ).toEqual({ address: c.email, name: "Dana Ruiz" });
    // The direct lead has no Reply-To at all.
    const [direct] = buildInbox(ref, "owner@example.com");
    expect(direct!.headers.some((x) => x.name === "Reply-To")).toBe(false);
    const rules = applyOwnerRules(classificationSchema.parse(FAKE_CLASSIFICATION), {
      firstTimeSender: true,
      senderIsVip: false,
      amountThresholdDollars: 2500,
      injection: injectionCheck(c.body).flagged,
    });
    expect(rules.needsOwner).toBe(false);
    const checked = checkDraft(FAKE_DRAFT.body, {
      sourceText: `${c.subject}\n${c.body}\nRuiz Street Plumbing. Water heaters, leaks, drains and repipes.`,
      doNotPromise: [],
      phrasesAvoided: [...FAKE_VOICE.phrases_avoided],
      neverSay: [],
    });
    expect(checked.flags).toEqual([]);
  });

  it("metadata reads: every header when none are named (as Gmail does), only the named ones otherwise", () => {
    const [lead] = buildInbox("abc123def456", "owner@example.com", Date.now(), { lead: "form" });
    const names = (r: ReturnType<typeof resource>) => r.payload.headers.map((x) => x.name);
    expect(names(resource(lead!, false))).toEqual(lead!.headers.map((x) => x.name));
    expect(names(resource(lead!, false, ["Reply-To"]))).toEqual(["Reply-To"]);
    expect(names(resource(lead!, false, ["From", "To"]))).not.toContain("Reply-To");
    expect(names(resource(lead!, true, ["From"]))).toContain("Reply-To");
  });

  it("the inbox: one customer email in the inbox and five older sent emails (enough for voice)", () => {
    const now = Date.now();
    const inbox = buildInbox("abc123def456", "owner@example.com", now);
    const inboxMail = inbox.filter((m) => m.labelIds.includes("INBOX"));
    const sent = inbox.filter((m) => m.labelIds.includes("SENT"));
    expect(inboxMail).toHaveLength(1);
    expect(sent).toHaveLength(5);
    expect(new Set(inbox.map((m) => m.threadId)).size).toBe(6);
    expect(inbox.every((m) => m.internalDate < now && m.internalDate > now - 30 * 86_400_000)).toBe(
      true,
    );
  });
});

describe("the fake server", () => {
  let server: Server;
  let url: string;
  const scenarioId = "7b0e5c9d-2f1a-4c3b-8d6e-0a1b2c3d4e5f";
  const ownerEmail = "owner-fake@example.com";

  const register = async (id: string, email: string, grant: FakeGrant = {}) => {
    const res = await fetch(`${url}/__scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ownerEmail: email, grant }),
    });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    ({ server, url } = await startFakes(0));
    await register(scenarioId, ownerEmail);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => vi.unstubAllEnvs());

  const recorded = async (id = scenarioId): Promise<FakeCall[]> =>
    ((await (await fetch(`${url}/__calls?scenario=${id}`)).json()) as { calls: FakeCall[] }).calls;

  const redirectUri = "http://localhost:3300/api/gmail/callback";

  /** The app's real consent request, answered by the fake's consent page (Allow is implied). */
  async function consent(email: string) {
    const asked = new URL(
      createGmailConnector().authorizationUrl({ state: "s1", redirectUri, loginHint: email }),
    );
    const res = await fetch(`${url}/o/oauth2/v2/auth${asked.search}`);
    expect(res.status).toBe(200);
  }

  /** Consent, then the code exchanged by hand: the token as issued, before any check of ours. */
  async function tokenScopes(id: string, email: string): Promise<string[]> {
    await consent(email);
    const res = await fetch(`${url}/google/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: `e2e-${id}`,
        client_id: "e2e-client-id",
        client_secret: "e2e-client-secret",
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { scope: string }).scope.split(" ");
  }

  /** A raw message to the owner's own address (what a practice copy is). */
  const ownRaw = (email: string) =>
    toGmailRaw(buildReplyMime({ from: email, to: email, subject: "[Practice] Hi", body: "Hi" }));

  /** The app's own e2e env, pointing at this fake. */
  function e2eEnv() {
    const env = {
      SA_E2E: "1",
      SA_E2E_GOOGLE_BASE_URL: `${url}/google`,
      SA_E2E_ANTHROPIC_BASE_URL: `${url}/anthropic`,
      DATABASE_URL: "postgres://sa:sa@localhost:5432/squared_away_launch",
      AUTH_GOOGLE_ID: "e2e-client-id",
      AUTH_GOOGLE_SECRET: "e2e-client-secret",
      VERCEL: undefined,
      VERCEL_ENV: undefined,
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return env;
  }

  it("listens on 127.0.0.1 only and answers JSON with a content-type", async () => {
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");
    const res = await fetch(`${url}/__health`);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("the real Anthropic SDK gets parsed structured output back (classify and draft)", async () => {
    const env = e2eEnv();
    const client = new Anthropic(anthropicClientOptions(env));
    const ref = refFor(scenarioId);
    for (const [schema, expected] of [
      [classificationSchema, FAKE_CLASSIFICATION],
      [draftSchema, FAKE_DRAFT],
    ] as const) {
      const response = await client.messages.parse({
        model: models.classify,
        max_tokens: 1000,
        system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `<email>Water heater, ref ${ref}</email>` }],
        output_config: { format: zodOutputFormat(schema) },
      });
      expect(response.parsed_output).toEqual(expected);
      expect(response.usage.input_tokens).toBeGreaterThan(0);
    }
    const kinds = (await recorded())
      .filter((c) => c.route === "anthropic.messages")
      .map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["classify", "draft"]));
  });

  it("the consent page needs a known login_hint and the exact scopes", async () => {
    const base = new URLSearchParams({
      client_id: "e2e-client-id",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ].join(" "),
      redirect_uri: redirectUri,
      state: "s1",
    });
    expect((await fetch(`${url}/o/oauth2/v2/auth?${base}`)).status).toBe(400);
    // The old request, with gmail.send (dropped 2026-10-15), is refused too.
    const oldThree = new URLSearchParams(base);
    oldThree.set("login_hint", ownerEmail);
    oldThree.set("scope", `${base.get("scope")} https://www.googleapis.com/auth/gmail.send`);
    expect((await fetch(`${url}/o/oauth2/v2/auth?${oldThree}`)).status).toBe(400);
    const stranger = new URLSearchParams(base);
    stranger.set("login_hint", "someone-else@example.com");
    expect((await fetch(`${url}/o/oauth2/v2/auth?${stranger}`)).status).toBe(400);
    const fewer = new URLSearchParams(base);
    fewer.set("login_hint", ownerEmail);
    fewer.set("scope", "openid email profile");
    expect((await fetch(`${url}/o/oauth2/v2/auth?${fewer}`)).status).toBe(400);
    const otherClient = new URLSearchParams(base);
    otherClient.set("login_hint", ownerEmail);
    otherClient.set("client_id", "1234-real.apps.googleusercontent.com");
    expect((await fetch(`${url}/o/oauth2/v2/auth?${otherClient}`)).status).toBe(400);
    const good = new URLSearchParams(base);
    good.set("login_hint", ownerEmail);
    const page = await (await fetch(`${url}/o/oauth2/v2/auth?${good}`)).text();
    expect(page).toContain(`code=e2e-${scenarioId}`);
    expect(page).toContain("state=s1");
  });

  it("asks for exactly the app's scopes, and those two cover every Gmail call the app makes", () => {
    expect(FAKE_GMAIL_SCOPES).toEqual(Object.values(GMAIL_SCOPES));
    expect(FAKE_CONNECT_SCOPES).toEqual(ALL_CONNECT_SCOPES);
    expect(Object.keys(GMAIL_METHOD_SCOPES).sort()).toEqual(
      [
        "gmail.profile",
        "gmail.messages.list",
        "gmail.messages.get",
        "gmail.history",
        "gmail.threads.get",
        "gmail.drafts.create",
        "gmail.drafts.get",
        "gmail.drafts.update",
        "gmail.drafts.delete",
        "gmail.drafts.send",
        "gmail.messages.send",
        "gmail.watch",
      ].sort(),
    );
    for (const [route, accepted] of Object.entries(GMAIL_METHOD_SCOPES))
      expect(
        accepted.some((x) => FAKE_GMAIL_SCOPES.includes(x)),
        route,
      ).toBe(true);
    // Google's reference: gmail.send alone covers messages.send and nothing else.
    const send = "https://www.googleapis.com/auth/gmail.send";
    expect(
      Object.entries(GMAIL_METHOD_SCOPES)
        .filter(([, accepted]) => accepted.includes(send))
        .map(([route]) => route),
    ).toEqual(["gmail.messages.send"]);
    // Both sends work with gmail.compose; every read with gmail.readonly.
    const compose = GMAIL_SCOPES.compose;
    expect(GMAIL_METHOD_SCOPES["gmail.drafts.send"]).toContain(compose);
    expect(GMAIL_METHOD_SCOPES["gmail.messages.send"]).toContain(compose);
    for (const read of ["messages.list", "messages.get", "history", "threads.get", "watch"])
      expect(GMAIL_METHOD_SCOPES[`gmail.${read}`], read).toContain(GMAIL_SCOPES.readonly);
  });

  it("Gmail behaves like Gmail for the paths the app depends on (drafts are DRAFT mail; a send is new SENT mail)", async () => {
    e2eEnv();
    // Connected the way the app does it: its consent request, its code exchange and checks.
    await consent(ownerEmail);
    const connected = await createGmailConnector().exchangeCode({
      code: `e2e-${scenarioId}`,
      redirectUri,
    });
    expect([...connected.grantedScopes].sort()).toEqual([...ALL_CONNECT_SCOPES].sort());
    const gmail = createGmailReader({ refreshToken: connected.refreshToken, maxRetries: 0 });
    const ref = refFor(scenarioId);
    const customer = fakeCustomer(ref);

    const profile = await gmail.getProfile();
    expect(profile.emailAddress).toBe(ownerEmail);
    const listed = await gmail.listMessages({ query: "newer_than:30d", maxResults: 4 });
    expect(listed.messages).toHaveLength(4);
    expect(listed.nextPageToken).toBeTruthy();
    const sentOnly = await gmail.listMessages({ query: "in:sent newer_than:365d" });
    expect(sentOnly.messages).toHaveLength(5);
    const incoming = await gmail.getMessage(customer.gmailMessageId, { withBody: true });
    expect(incoming?.bodyText).toContain(`Ref ${ref}`);

    // A draft: a DRAFT-labelled message that history reports.
    const body = "Hi Dana,\n\nCould you send a photo?\n\nThanks,\nMike";
    const raw = toGmailRaw(
      buildReplyMime({
        from: ownerEmail,
        to: customer.email,
        subject: replySubject(customer.subject),
        inReplyTo: customer.messageIdHeader,
        body,
      }),
    );
    const created = await gmail.createDraft({ threadId: customer.gmailThreadId, raw });
    const history = await gmail.listHistory({ startHistoryId: profile.historyId });
    expect(history.added).toMatchObject([
      { id: created.messageId, threadId: customer.gmailThreadId },
    ]);
    expect(Number(history.historyId)).toBeGreaterThan(Number(profile.historyId));
    const asMail = await gmail.getMessage(created.messageId, { withBody: false });
    expect(asMail?.labelIds).toContain("DRAFT");
    expect(await gmail.threadDraftMessageIds(customer.gmailThreadId)).toEqual([created.messageId]);
    const read = await gmail.getDraft(created.draftId);
    expect(sameText(read?.bodyText, body)).toBe(true);

    // An update makes a new message id, as Gmail does.
    const updated = await gmail.updateDraft(created.draftId, {
      threadId: customer.gmailThreadId,
      raw,
    });
    expect(updated.messageId).not.toBe(created.messageId);

    // Sending: a new SENT message in the thread, reported by history; the draft is gone.
    const sent = await gmail.sendDraft(created.draftId);
    expect(sent.threadId).toBe(customer.gmailThreadId);
    expect(sent.messageId).not.toBe(updated.messageId);
    expect((await gmail.getMessage(sent.messageId, { withBody: false }))?.labelIds).toEqual([
      "SENT",
    ]);
    expect(await gmail.getDraft(created.draftId)).toBeNull();
    const after = await gmail.listHistory({ startHistoryId: history.historyId });
    expect(after.added.map((m) => m.id)).toContain(sent.messageId);

    const all = await recorded();
    const send = all.filter((c) => c.route === "gmail.drafts.send");
    expect(send).toHaveLength(1);
    expect(send[0]!.mail).toMatchObject({
      from: ownerEmail,
      to: customer.email,
      subject: replySubject(customer.subject),
      inReplyTo: customer.messageIdHeader,
      references: customer.messageIdHeader,
      threadId: customer.gmailThreadId,
    });
    expect(all.filter((c) => c.route === "unknown")).toEqual([]);
    // Every call was allowed by the two scopes the token carries.
    expect(all.filter((c) => c.insufficientScope)).toEqual([]);
    const practice = await gmail.sendMessage(ownRaw(ownerEmail));
    expect(practice.messageId).toBeTruthy();
  });

  it("enforces scopes on the token it issued, as Google does", async () => {
    e2eEnv();
    const refused = async (id: string) =>
      (await recorded(id)).filter((c) => c.insufficientScope).map((c) => c.route);

    // An old partial grant: read and gmail.send, no gmail.compose. No draft can be made or
    // sent; only a new message can go out (all that gmail.send ever allowed).
    const sendOnly = "2c4e6a8b-1d3f-4a5b-9c7d-0e1f2a3b4c5d";
    await register(sendOnly, "send-only@example.com", {
      untick: [GMAIL_SCOPES.compose],
      earlier: ["https://www.googleapis.com/auth/gmail.send"],
    });
    const granted = await tokenScopes(sendOnly, "send-only@example.com");
    expect(granted).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(granted).not.toContain(GMAIL_SCOPES.compose);
    const a = createGmailReader({ refreshToken: `rt-${sendOnly}`, maxRetries: 0 });
    expect((await a.listMessages({ query: "newer_than:30d" })).messages.length).toBeGreaterThan(0);
    const customer = fakeCustomer(refFor(sendOnly));
    await expect(
      a.createDraft({ threadId: customer.gmailThreadId, raw: ownRaw("send-only@example.com") }),
    ).rejects.toBeInstanceOf(MailboxAuthError);
    await expect(a.sendDraft("d-any")).rejects.toBeInstanceOf(MailboxAuthError);
    expect((await a.sendMessage(ownRaw("send-only@example.com"))).messageId).toBeTruthy();
    expect(await refused(sendOnly)).toEqual(["gmail.drafts.create", "gmail.drafts.send"]);

    // gmail.compose without gmail.readonly: drafts and sends, but no reading the inbox.
    const noRead = "3d5f7b9c-2e4a-4b6c-8d0e-1f2a3b4c5d6e";
    await register(noRead, "no-read@example.com", { untick: [GMAIL_SCOPES.readonly] });
    expect(await tokenScopes(noRead, "no-read@example.com")).not.toContain(GMAIL_SCOPES.readonly);
    const b = createGmailReader({ refreshToken: `rt-${noRead}`, maxRetries: 0 });
    await expect(b.listMessages({ query: "newer_than:30d" })).rejects.toBeInstanceOf(
      MailboxAuthError,
    );
    const other = fakeCustomer(refFor(noRead));
    const draft = await b.createDraft({
      threadId: other.gmailThreadId,
      raw: ownRaw("no-read@example.com"),
    });
    expect((await b.sendDraft(draft.draftId)).threadId).toBe(other.gmailThreadId);
    expect(await refused(noRead)).toEqual(["gmail.messages.list"]);
  });

  it("the app's connect refuses a grant missing either scope, revokes it, and keeps an extra gmail.send", async () => {
    e2eEnv();
    for (const [i, missing] of [GMAIL_SCOPES.compose, GMAIL_SCOPES.readonly].entries()) {
      // The fake tells scenarios apart by the id's first 12 hex digits.
      const id = `4e6a8c0${i}-3f5b-4c7d-9e1f-2a3b4c5d6e70`;
      const email = `unticked-${i}@example.com`;
      await register(id, email, { untick: [missing] });
      await consent(email);
      const err = await createGmailConnector()
        .exchangeCode({ code: `e2e-${id}`, redirectUri })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingScopesError);
      expect((err as MissingScopesError).missing).toEqual([missing]);
      const calls = (await recorded(id)).map((c) => c.route);
      expect(calls).toContain("revoke");
      expect(calls).not.toContain("userinfo");
      // The grant is gone: the refresh token no longer works.
      await expect(
        createGmailReader({ refreshToken: `rt-${id}`, maxRetries: 0 }).getProfile(),
      ).rejects.toBeInstanceOf(MailboxAuthError);
    }

    // Connected before 2026-10-15: Google adds the old gmail.send back. Accepted, works as usual.
    const older = "5f7b9d1e-4a6c-4d8e-8f2a-3b4c5d6e7f80";
    await register(older, "older@example.com", {
      earlier: ["https://www.googleapis.com/auth/gmail.send"],
    });
    await consent("older@example.com");
    const connected = await createGmailConnector().exchangeCode({
      code: `e2e-${older}`,
      redirectUri,
    });
    expect(connected.grantedScopes).toEqual([
      ...ALL_CONNECT_SCOPES,
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    const c = createGmailReader({ refreshToken: connected.refreshToken, maxRetries: 0 });
    const customer = fakeCustomer(refFor(older));
    const draft = await c.createDraft({
      threadId: customer.gmailThreadId,
      raw: ownRaw("older@example.com"),
    });
    expect((await c.sendDraft(draft.draftId)).threadId).toBe(customer.gmailThreadId);
  });

  it("a refresh token it never issued gets what real Google tells a dummy client", async () => {
    e2eEnv();
    const gmail = createGmailReader({ refreshToken: "fake-refresh-token", maxRetries: 0 });
    await expect(gmail.getProfile()).rejects.toThrow("Token refresh failed (401).");
  });

  it("refuses any credentials but the e2e ones, and records that without the value (A3)", async () => {
    const before = (await recorded()).length;
    const token = (form: Record<string, string>) =>
      fetch(`${url}/google/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
    const realSecret = "GOCSPX-a-real-looking-secret";
    const forms: Record<string, string>[] = [
      {
        grant_type: "authorization_code",
        code: `e2e-${scenarioId}`,
        client_id: "e2e-client-id",
        client_secret: realSecret,
      },
      {
        grant_type: "refresh_token",
        refresh_token: `rt-${scenarioId}`,
        client_id: "1234-real.apps.googleusercontent.com",
        client_secret: "e2e-client-secret",
      },
    ];
    for (const form of forms) {
      const res = await token(form);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_client" });
    }
    const model = await fetch(`${url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-real-looking" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: refFor(scenarioId) }],
      }),
    });
    expect(model.status).toBe(401);
    const added = (await recorded()).slice(before);
    expect(added).toHaveLength(3);
    expect(added.every((c) => c.wrongClient === true)).toBe(true);
    const text = JSON.stringify(added);
    for (const value of [realSecret, "1234-real", "sk-ant-real-looking"])
      expect(text).not.toContain(value);
  });

  it("records no secrets: no client secret, code or token", async () => {
    e2eEnv();
    await consent(ownerEmail);
    const res = await fetch(`${url}/google/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: `e2e-${scenarioId}`,
        client_id: "e2e-client-id",
        client_secret: "e2e-client-secret",
      }),
    });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await recorded());
    for (const secret of [
      "client_secret",
      "e2e-client-secret",
      `e2e-${scenarioId}`,
      `rt-${scenarioId}`,
      `at-${scenarioId}`,
      "Bearer",
    ])
      expect(text).not.toContain(secret);
  });
});
