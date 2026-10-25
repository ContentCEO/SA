import NextAuth, { type DefaultSession } from "next-auth";
import "next-auth/jwt";
import Google from "next-auth/providers/google";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import { takeSignInAgreement } from "@/server/terms";

declare module "next-auth" {
  interface Session {
    /** `sv`: the account's session version this sign-in was made at (Check 26 P3). */
    /** `sat`: when this sign-in happened (seconds; Check 26 P4). */
    user: { id: string; sv?: number; sat?: number } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    /** Check 26 P3: `users.session_version` at sign-in. A different number = signed out. */
    sv?: number;
    /**
     * Check 26 P4: when the person last signed in with Google (seconds). Auth.js re-issues the
     * token (and its `iat`) on every visit, so `iat` can't tell a fresh sign-in apart.
     */
    sat?: number;
  }
}

/**
 * Sign-in only asks Google for who you are (openid, email, profile).
 * Gmail access is a separate, explained step — see src/app/api/gmail/*.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google({ authorization: { params: { scope: "openid email profile" } } })],
  session: { strategy: "jwt" },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    async signIn({ profile }) {
      if (!profile?.email || profile.email_verified === false) return false;
      if (!(await isAllowedToSignIn(profile.email))) return "/not-invited";
      return true;
    },
    async jwt({ token, profile }) {
      // `profile` is only present on the sign-in request itself.
      if (profile?.email) {
        const { user } = await ensureUserAndWorkspace({
          email: profile.email,
          name: typeof profile.name === "string" ? profile.name : null,
        });
        token.uid = user.id;
        // Check 26 P3: "Sign out of every phone and computer" moves the account's version on,
        // and every sign-in made before it stops working (src/server/session.ts).
        token.sv = user.sessionVersion;
        token.sat = Math.floor(Date.now() / 1000);
        // The sign-in button's "I agree" box (Davi, 2026-10-15): record it on the account.
        // Without it, the first screen asks again (requireOwner → /welcome/terms).
        await takeSignInAgreement(user.id);
      }
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid;
      if (typeof token.sv === "number") session.user.sv = token.sv;
      if (typeof token.sat === "number") session.user.sat = token.sat;
      return session;
    },
  },
});
