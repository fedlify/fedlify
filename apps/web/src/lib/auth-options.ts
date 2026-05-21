import argon2 from "argon2";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import { prisma } from "@/lib/prisma";
import { ensureUserDefaults } from "@/lib/defaults";

const providers: NextAuthOptions["providers"] = [
  CredentialsProvider({
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" }
    },
    async authorize(credentials) {
      const email = credentials?.email?.trim().toLowerCase();
      const password = credentials?.password ?? "";
      if (!email || !password) return null;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.passwordHash) return null;

      const ok = await argon2.verify(user.passwordHash, password);
      if (!ok) return null;

      await ensureUserDefaults(prisma, user.id);
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image
      };
    }
  })
];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    })
  );
}

if (process.env.SMTP_HOST) {
  providers.push(
    EmailProvider({
      server: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        auth:
          process.env.SMTP_USER && process.env.SMTP_PASSWORD
            ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD
              }
            : undefined
      },
      from: process.env.SMTP_FROM ?? "Fedlify <no-reply@fedlify.local>"
    })
  );
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers,
  pages: {
    signIn: "/signin"
  },
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 8
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
      }

      if (token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { platformRole: true }
        });
        token.platformRole = dbUser?.platformRole ?? "USER";
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.platformRole = (token.platformRole as string | undefined) ?? "USER";
      }
      return session;
    }
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureUserDefaults(prisma, user.id);
      }
    }
  }
};
