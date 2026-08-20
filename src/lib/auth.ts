import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { db } from '@/lib/db';

// S0-3: NEXTAUTH_SECRET must be set in the environment. No fallback.
// If it's missing, the app throws at startup — better to fail than to use
// a predictable secret that allows JWT forgery.
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;
if (!NEXTAUTH_SECRET) {
  throw new Error(
    'FATAL: NEXTAUTH_SECRET environment variable is not set. ' +
    'Generate one with: openssl rand -hex 32. ' +
    'No fallback is provided — a missing secret is a startup failure.'
  );
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await db.user.findUnique({
          where: { email: credentials.email.toLowerCase() },
        });

        if (!user) return null;

        // Check password
        if (user.password) {
          const bcrypt = await import('bcryptjs');
          const isValid = await bcrypt.compare(credentials.password, user.password);
          if (!isValid) return null;
        }

        // Check if user is approved (not on waitlist)
        if (user.waitlist && !user.approved) {
          throw new Error('Your account is on the waitlist. An admin will approve it soon.');
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name || user.email,
          role: user.role,
        };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/auth/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role;
      }
      return session;
    },
  },
  secret: NEXTAUTH_SECRET,
};
