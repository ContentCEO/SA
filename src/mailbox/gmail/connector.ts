import "server-only";
import { z } from "zod";
import { MissingScopesError, type ConnectResult, type MailboxConnector } from "../connector";
import { ALL_CONNECT_SCOPES, REQUIRED_GMAIL_SCOPES, missingScopes } from "./scopes";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  scope: z.string(),
});

const userInfo = z.object({ email: z.string().email(), email_verified: z.boolean().optional() });

type Fetch = typeof fetch;

function clientCredentials() {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are not set. See .env.example.");
  }
  return { clientId, clientSecret };
}

export function createGmailConnector(fetchImpl: Fetch = fetch): MailboxConnector {
  async function revoke(tokenValue: string) {
    const res = await fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokenValue }),
    });
    // 400 invalid_token means it's already revoked — that's the outcome we wanted.
    if (!res.ok && res.status !== 400) {
      throw new Error(`Google token revoke failed (${res.status}).`);
    }
  }

  return {
    provider: "gmail",
    requiredScopes: REQUIRED_GMAIL_SCOPES,

    authorizationUrl({ state, redirectUri, loginHint }) {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientCredentials().clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: ALL_CONNECT_SCOPES.join(" "),
        // Offline + consent guarantees Google hands us a refresh token every time.
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, redirectUri }): Promise<ConnectResult> {
      const { clientId, clientSecret } = clientCredentials();
      const res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!res.ok) throw new Error(`Google token exchange failed (${res.status}).`);
      const token = tokenResponse.parse(await res.json());

      const grantedScopes = token.scope.split(" ").filter(Boolean);
      const missing = missingScopes(grantedScopes);
      if (missing.length > 0) {
        // Don't keep a half-permissioned token around.
        await revoke(token.refresh_token ?? token.access_token);
        throw new MissingScopesError(missing);
      }
      if (!token.refresh_token) throw new Error("Google did not return a refresh token.");

      const infoRes = await fetchImpl(USERINFO_URL, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (!infoRes.ok) throw new Error(`Google userinfo failed (${infoRes.status}).`);
      const info = userInfo.parse(await infoRes.json());

      return { email: info.email.toLowerCase(), refreshToken: token.refresh_token, grantedScopes };
    },

    revoke,
  };
}
