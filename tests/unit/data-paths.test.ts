import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMS_VERSION } from "@/config/legal";
import { ALLOWED_DATA_PATHS } from "@/config/models";
import { parseText, rel, sourceFiles, ts, walk } from "../support/source-ast";

/**
 * Check 48 P7: where email text may go. The privacy policy ("Where your information goes") says
 * email text goes to one outside service, Anthropic, for the task at hand, and that "Anthropic may
 * keep it for a limited time under its own policies". Today every model call is one
 * `messages.create` in src/ai/client.ts. This walks src/ and fails on anything that would quietly
 * break that promise:
 *  - Anthropic's Message Batches API or Files API (both store data for longer), unless
 *    ALLOWED_DATA_PATHS in src/config/models.ts turns it on with a policy update;
 *  - a model on Anthropic's "Covered Models" list (30-day retention), anywhere;
 *  - fetch() to a host that isn't on FETCH_HOSTS (each tied to a privacy-policy line);
 *  - any other AI SDK, or the Anthropic SDK outside src/ai/client.ts.
 */

/**
 * Anthropic "Covered Models" that require 30-day retention (platform.claude.com, "API and data
 * retention"). Named only here, as models to refuse.
 */
const COVERED_MODELS = [
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5",
  "claude-mythos-5-1",
];

/** Hosts src/ may fetch(), each with the privacy-policy line that covers it. */
const FETCH_HOSTS: Record<string, string> = {
  // privacy-policy.md "Where your information goes": "**Google** — your Gmail, through the
  // permissions above." (and sign-in / Gmail connect under "When you sign in with Google")
  "gmail.googleapis.com": "Google",
  "oauth2.googleapis.com": "Google",
  "openidconnect.googleapis.com": "Google",
  // Check 26 P10: Google's public signing keys, to check Gmail push requests (sends nothing).
  "www.googleapis.com": "Google",
  "accounts.google.com": "Google",
  // "**Resend** — delivers our emails to you …"
  "api.resend.com": "Resend",
  // "**Twilio** — only if you turn on text alerts: delivers texts to your own phone …"
  "api.twilio.com": "Twilio",
};

/**
 * Plan #49 (Outlook, off unless FEATURE_OUTLOOK): Microsoft hosts, reached only for an owner who
 * connected an Outlook mailbox. Their privacy-policy line is written word for word in
 * docs/notes/legal-m12-outlook.md and goes into docs/privacy-policy.md before the switch is
 * turned on (docs/SETUP.md §8b step 6); until then the test below accepts it from the note.
 */
const FETCH_HOSTS_AWAITING_POLICY: Record<string, string> = {
  "graph.microsoft.com": "Microsoft",
  "login.microsoftonline.com": "Microsoft",
};
const LEGAL_NOTE = "docs/notes/legal-m12-outlook.md";
const ALLOWED_HOSTS: Record<string, string> = { ...FETCH_HOSTS, ...FETCH_HOSTS_AWAITING_POLICY };

/**
 * Files that call fetch with a URL built at run time, each with why the host is covered. Their
 * https:// literals must still be on FETCH_HOSTS (checked below). Stripe, Inngest, Sentry and
 * Vercel are reached through their own SDKs (policy lines "**Stripe**", "**Inngest**",
 * "**Sentry**", "**Vercel**"), not fetch.
 */
const DYNAMIC_FETCH: Record<string, string> = {
  "src/mailbox/gmail/api.ts": "Google: Gmail API, base URLs from src/config/e2e.ts googleEndpoints",
  "src/mailbox/gmail/connector.ts": "Google: OAuth token, userinfo and revoke endpoints",
  // "**Your browser's push service** (Google, Apple, Mozilla or Microsoft) — … an empty ping"
  "src/lib/web-push.ts": "push services only: isPushEndpoint (src/lib/push-endpoint.ts)",
  "src/components/app/app-badge.tsx": "same origin: /api/badge (a count, no content)",
  "src/mailbox/outlook/http.ts":
    "Microsoft: Graph and token endpoints from src/config/e2e.ts microsoftEndpoints (plan #49)",
  "src/mailbox/outlook/connector.ts": "Microsoft: token exchange and the owner's /me (plan #49)",
};
/** Where the Google base URLs live (checked against FETCH_HOSTS too). */
const URL_TABLES = ["src/config/e2e.ts"];

/** Other AI SDKs: email text may go to Anthropic only. */
const OTHER_AI_SDK =
  /^(openai|@openai\/|@google\/(generative-ai|genai)|@google-cloud\/(aiplatform|vertexai)|cohere-ai|@mistralai\/|ai$|@ai-sdk\/|langchain|@langchain\/|replicate|groq-sdk|together-ai|ollama|@huggingface\/|@aws-sdk\/client-bedrock|@azure\/openai)/;
/** The one file that may import the Anthropic SDK. */
const ANTHROPIC_CLIENT = "src/ai/client.ts";

type Finding = { file: string; what: string };

function scan(file: string, text: string): Finding[] {
  const sf = parseText(file, text);
  const out: Finding[] = [];
  const add = (what: string) => out.push({ file, what });

  for (const id of COVERED_MODELS) if (text.includes(id)) add(`names covered model ${id}`);

  walk(sf, (n) => {
    // Anthropic Message Batches / Files APIs.
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      const owner = n.expression.getText();
      if (name === "batches" && !ALLOWED_DATA_PATHS.batch) add(`uses ${owner}.batches`);
      if (
        name === "files" &&
        /(^|\.)(beta|client|anthropic)$/i.test(owner) &&
        !ALLOWED_DATA_PATHS.files
      ) {
        add(`uses ${owner}.files`);
      }
      if (name === "upload" && /(^|\.)files$/.test(owner) && !ALLOWED_DATA_PATHS.files) {
        add(`uses ${owner}.upload`);
      }
    }

    // Imports: other AI SDKs, and the Anthropic SDK outside the client.
    const spec =
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
        ? n.moduleSpecifier.text
        : ts.isCallExpression(n) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
            n.arguments[0] &&
            ts.isStringLiteral(n.arguments[0])
          ? n.arguments[0].text
          : null;
    if (spec && OTHER_AI_SDK.test(spec)) add(`imports AI SDK ${spec}`);
    if (spec?.startsWith("@anthropic-ai/") && file !== ANTHROPIC_CLIENT) {
      add(`imports ${spec} outside ${ANTHROPIC_CLIENT}`);
    }

    // fetch(): a literal URL must be relative or on FETCH_HOSTS; anything else must be listed.
    if (ts.isIdentifier(n) && n.text === "fetch") {
      const p = n.parent;
      if (ts.isTypeQueryNode(p) || (ts.isPropertyAccessExpression(p) && p.name === n)) return;
      if (ts.isPropertyAssignment(p) && p.name === n) return;
      const call = ts.isCallExpression(p) && p.expression === n ? p : null;
      const arg = call?.arguments[0];
      const literal =
        arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))
          ? ts.isTemplateExpression(arg)
            ? arg.head.text
            : arg.text
          : null;
      if (literal !== null && literal.startsWith("/")) return;
      const host = literal?.match(/^https?:\/\/([^/:?#]+)/)?.[1];
      if (host) {
        if (!(host in ALLOWED_HOSTS)) add(`fetches ${host}`);
        return;
      }
      if (!(file in DYNAMIC_FETCH)) add("calls fetch with a URL built at run time");
    }
  });

  if (file in DYNAMIC_FETCH || URL_TABLES.includes(file)) {
    walk(sf, (n) => {
      if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n)) {
        const host = n.text.match(/^https?:\/\/([^/:?#]+)/)?.[1];
        if (host && !(host in ALLOWED_HOSTS)) add(`names host ${host}`);
      }
    });
  }
  return out;
}

const SRC_FILES = sourceFiles().map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));

describe("email text goes only where the privacy policy says (Check 48 P7)", () => {
  it("src/ has no batch or files API, covered model, unlisted fetch host or other AI SDK", () => {
    const found = SRC_FILES.flatMap(({ file, text }) => scan(file, text)).map(
      (f) => `${f.file}: ${f.what}`,
    );
    expect(found).toEqual([]);
  });

  it("the scan reaches the files it should", () => {
    expect(SRC_FILES.some((f) => f.file === ANTHROPIC_CLIENT)).toBe(true);
    for (const file of [...Object.keys(DYNAMIC_FETCH), ...URL_TABLES]) {
      expect(
        SRC_FILES.some((f) => f.file === file),
        file,
      ).toBe(true);
    }
    // The model call is a plain messages request.
    // (Check 29 P1: messages.create, parsed in our code, instead of messages.parse.)
    expect(SRC_FILES.find((f) => f.file === ANTHROPIC_CLIENT)!.text).toContain("messages.create");
  });

  it("each allow-list entry names its privacy-policy line, and those lines exist", () => {
    const policy = readFileSync("docs/privacy-policy.md", "utf8");
    for (const vendor of new Set(Object.values(FETCH_HOSTS))) {
      expect(policy, vendor).toContain(`**${vendor}** —`);
    }
    // Plan #49: in the policy already, or written word for word in the legal note for it.
    const note = readFileSync(LEGAL_NOTE, "utf8");
    for (const vendor of new Set(Object.values(FETCH_HOSTS_AWAITING_POLICY))) {
      expect(policy.includes(`**${vendor}** —`) || note.includes(`**${vendor}** —`), vendor).toBe(
        true,
      );
    }
    for (const vendor of ["Anthropic", "Stripe", "Inngest", "Sentry", "Vercel"]) {
      expect(policy, vendor).toContain(`**${vendor}** —`);
    }
    expect(policy).toContain("**Your browser's push service**");
    expect(policy).toContain("Anthropic may keep it for a limited time under its own policies");
  });

  it("batch and files stay off until the policy says so", () => {
    const policy = readFileSync("docs/privacy-policy.md", "utf8");
    // Turning one on needs the policy to name it, and a new terms version.
    if (ALLOWED_DATA_PATHS.batch) expect(policy).toMatch(/Batch/);
    if (ALLOWED_DATA_PATHS.files) expect(policy).toMatch(/Files API/);
    if (ALLOWED_DATA_PATHS.batch || ALLOWED_DATA_PATHS.files) {
      expect(TERMS_VERSION > "2026-10-16").toBe(true);
    }
    expect(ALLOWED_DATA_PATHS).toEqual({ batch: false, files: false });
  });

  it("self-test: each forbidden shape is caught", () => {
    const what = (code: string, file = "src/server/fixture.ts") =>
      scan(file, code).map((f) => f.what);
    expect(what("await client.messages.batches.create({ requests });")).toEqual([
      "uses client.messages.batches",
    ]);
    expect(what("await anthropic.beta.files.upload({ file });")).toEqual([
      "uses anthropic.beta.files.upload",
      "uses anthropic.beta.files",
    ]);
    expect(what(`const model = "${COVERED_MODELS[2]}";`)).toEqual([
      `names covered model ${COVERED_MODELS[2]}`,
    ]);
    expect(what('await fetch("https://api.example.com/x");')).toEqual(["fetches api.example.com"]);
    expect(what('await fetch("https://api.anthropic.com/v1/messages");')).toEqual([
      "fetches api.anthropic.com",
    ]);
    expect(what("await fetch(url);")).toEqual(["calls fetch with a URL built at run time"]);
    expect(what('import OpenAI from "openai";')).toEqual(["imports AI SDK openai"]);
    expect(what('import Anthropic from "@anthropic-ai/sdk";')).toEqual([
      `imports @anthropic-ai/sdk outside ${ANTHROPIC_CLIENT}`,
    ]);
    // Allowed shapes.
    expect(what('await fetch("/api/badge"); await fetch(`/api/drafts/${id}/send`);')).toEqual([]);
    expect(what('await fetch("https://api.resend.com/emails");')).toEqual([]);
    expect(what("type F = typeof fetch;")).toEqual([]);
  });
});
