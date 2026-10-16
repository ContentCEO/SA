import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyOwnerRules } from "@/ai/classify";
import { checkDraft, REGENERATE_ON } from "@/ai/draft-checks";
import { injectionCheck, looksMunicipal } from "@/ai/guards";
import { classificationSchema } from "@/ai/prompts/classify.v3";
import { draftSchema } from "@/ai/prompts/draft.v5";
import { editToneSchema } from "@/ai/prompts/edit-tone.v1";
import { voiceSchema } from "@/ai/prompts/voice.v2";
import { anthropicClientOptions } from "@/config/e2e";
import { models } from "@/config/models";
import { createGmailReader } from "@/mailbox/gmail/api";
import { buildReplyMime, replySubject, sameText, toGmailRaw } from "@/mailbox/mime";
import {
  buildInbox,
  FAKE_CLASSIFICATION,
  FAKE_DRAFT,
  FAKE_EDIT_TONE,
  FAKE_VOICE,
  fakeCustomer,
  outputKindFor,
  refFor,
} from "../e2e/fakes/outputs";
import { startFakes, type FakeCall } from "../e2e/fakes/server";

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

  beforeAll(async () => {
    ({ server, url } = await startFakes(0));
    const res = await fetch(`${url}/__scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: scenarioId, ownerEmail }),
    });
    expect(res.status).toBe(201);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => vi.unstubAllEnvs());

  const recorded = async (): Promise<FakeCall[]> =>
    ((await (await fetch(`${url}/__calls?scenario=${scenarioId}`)).json()) as { calls: FakeCall[] })
      .calls;

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
        "https://www.googleapis.com/auth/gmail.send",
      ].join(" "),
      redirect_uri: "http://localhost:3300/api/gmail/callback",
      state: "s1",
    });
    expect((await fetch(`${url}/o/oauth2/v2/auth?${base}`)).status).toBe(400);
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

  it("Gmail behaves like Gmail for the paths the app depends on (drafts are DRAFT mail; a send is new SENT mail)", async () => {
    e2eEnv();
    const gmail = createGmailReader({ refreshToken: `rt-${scenarioId}`, maxRetries: 0 });
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
