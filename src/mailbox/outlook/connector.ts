import "server-only";
import { z } from "zod";
import {
  MissingScopesError,
  NoOutlookMailboxError,
  ProviderCannotRevokeError,
  type ConnectResult,
  type MailboxConnector,
} from "../connector";
import { microsoftEndpoints } from "@/config/e2e";
import { outlookClientCredentials } from "@/config/outlook";
import { IMMUTABLE_ID } from "./http";
import { missingOutlookScopes, REQUIRED_OUTLOOK_SCOPES } from "./scopes";

/**
 * The browser's Microsoft sign-in page (work Microsoft 365 and personal outlook.com accounts:
 * the `common` endpoint). Never overridable (local e2e routes it in the browser).
 */
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  scope: z.string().default(""),
});

const me = z.object({
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
});

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

type Fetch = typeof fetch;

function credentials() {
  const creds = outlookClientCredentials();
  if (!creds) throw new Error("Outlook is not switched on (FEATURE_OUTLOOK / MS_CLIENT_ID).");
  return creds;
}

/** The owner's address: `mail`, else the sign-in name (personal accounts often leave `mail` empty). */
export function addressFromMe(body: unknown): string | null {
  const parsed = me.safeParse(body);
  if (!parsed.success) return null;
  for (const v of [parsed.data.mail, parsed.data.userPrincipalName]) {
    const a = (v ?? "").trim().toLowerCase();
    if (EMAIL.test(a)) return a;
  }
  return null;
}

/**
 * Plan #49: connecting an Outlook / Microsoft 365 mailbox. Same rules as Gmail's: exactly our
 * permissions or nothing is saved, and a refresh token every time (`offline_access`).
 *
 * Revoke: Microsoft has no call that ends one app's delegated grant (only "sign out of every
 * session", which would sign the owner out of their own Outlook everywhere). `revoke` throws
 * `ProviderCannotRevokeError`; Disconnect deletes our tokens anyway and tells the owner how to
 * remove the app at account.microsoft.com. On a refused connect the tokens are simply dropped.
 */
export function createOutlookConnector(fetchImpl: Fetch = fetch): MailboxConnector {
  return {
    provider: "outlook",
    requiredScopes: REQUIRED_OUTLOOK_SCOPES,

    authorizationUrl({ state, redirectUri, loginHint, prompt, codeChallenge }) {
      if (!codeChallenge) throw new Error("Outlook connect needs a PKCE challenge.");
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: credentials().clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        response_mode: "query",
        scope: REQUIRED_OUTLOOK_SCOPES.join(" "),
        // Microsoft takes one prompt value: the account chooser when adding another inbox,
        // otherwise fresh consent (so a reconnect shows the permissions again).
        prompt: prompt === "consent select_account" ? "select_account" : "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier }): Promise<ConnectResult> {
      if (!codeVerifier) throw new Error("Outlook connect needs the PKCE verifier.");
      const { clientId, clientSecret } = credentials();
      const res = await fetchImpl(microsoftEndpoints().token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
          scope: REQUIRED_OUTLOOK_SCOPES.join(" "),
        }),
      });
      if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status}).`);
      const token = tokenResponse.parse(await res.json());
      const grantedScopes = token.scope.split(" ").filter(Boolean);
      const missing = missingOutlookScopes(grantedScopes, !!token.refresh_token);
      // Nothing to revoke at Microsoft: the tokens are dropped here, never saved.
      if (missing.length > 0) throw new MissingScopesError(missing);
      if (!token.refresh_token) throw new Error("Microsoft did not return a refresh token.");

      const graph = (path: string) =>
        fetchImpl(`${microsoftEndpoints().graph}${path}`, {
          headers: { authorization: `Bearer ${token.access_token}`, prefer: IMMUTABLE_ID },
        });

      const meRes = await graph("/me?$select=mail,userPrincipalName");
      if (!meRes.ok) throw new Error(`Microsoft profile failed (${meRes.status}).`);
      const email = addressFromMe(await meRes.json());
      if (!email) throw new Error("Microsoft gave no email address.");

      // A Microsoft account isn't always a mailbox Graph can reach. Ask before anything is
      // saved (the trial clock starts on the first save).
      const inbox = await graph("/me/mailFolders/inbox?$select=id");
      if (!inbox.ok) {
        const err = (await inbox.json().catch(() => ({}))) as { error?: { code?: string } };
        if (
          inbox.status === 404 ||
          /MailboxNotEnabledForRESTAPI|MailboxNotHostedInExchangeOnline|ResourceNotFound/i.test(
            err.error?.code ?? "",
          )
        )
          throw new NoOutlookMailboxError();
        throw new Error(`Outlook inbox check failed (${inbox.status}).`);
      }

      return { email, refreshToken: token.refresh_token, grantedScopes };
    },

    async revoke() {
      throw new ProviderCannotRevokeError();
    },
  };
}
