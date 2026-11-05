import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

declare module "next-auth" {
  interface Session {
    googleSub?: string;
  }
}

/** True when the deployment has Google OAuth credentials and a session secret. */
export function googleSignInEnabled(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && (process.env.AUTH_SECRET || process.env.SESSION_SECRET));
}

/**
 * Google is an extra way in. The Datum cookie is still issued afterwards,
 * so payments keep using the phone session. Auth.js is initialised lazily
 * and does nothing useful until the Google env vars are set.
 */
export const { handlers, auth, signIn } = NextAuth(() => ({
  trustHost: true,
  secret: process.env.AUTH_SECRET || process.env.SESSION_SECRET,
  session: { strategy: "jwt" },
  providers: googleSignInEnabled() ? [Google] : [],
  callbacks: {
    jwt({ token, account }) {
      if (account?.provider === "google" && account.providerAccountId) {
        token.googleSub = account.providerAccountId;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.googleSub === "string") session.googleSub = token.googleSub;
      return session;
    },
  },
}));
