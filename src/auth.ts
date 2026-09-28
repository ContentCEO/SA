import NextAuth, { type DefaultSession } from "next-auth";
import "next-auth/jwt";
import Google from "next-auth/providers/google";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}

/**
 * Sign-in only asks Google for who you are (openid, email, profile).
 * Gmail access is a separate, explained step — see src/app/api/gmail/*.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google({ authorization: { params: { scope: "openid email profile" } } })],
  session: { strategy: "jwt" },
  pages: { signIn: "/", error: "/" },
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
      }
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid;
      return session;
    },
  },
});
