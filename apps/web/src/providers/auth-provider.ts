"use client";

import type { AuthProvider } from "@refinedev/core";
import { getSession, signIn, signOut } from "next-auth/react";

export const authProvider: AuthProvider = {
  login: async ({ email, password }) => {
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false
    });

    if (result?.ok) return { success: true, redirectTo: "/dashboard" };
    return { success: false, error: { name: "LoginError", message: "Invalid email or password." } };
  },
  logout: async () => {
    await signOut({ redirect: false });
    return { success: true, redirectTo: "/signin" };
  },
  check: async () => {
    const session = await getSession();
    if (session) return { authenticated: true };
    return { authenticated: false, redirectTo: "/signin" };
  },
  getIdentity: async () => {
    const session = await getSession();
    return session?.user ?? null;
  },
  onError: async (error) => {
    if (error?.status === 401) return { logout: true };
    return { error };
  }
};
