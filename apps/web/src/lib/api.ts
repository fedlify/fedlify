import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { problem } from "@/lib/json";

export async function requireUser() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { response: problem(401, "Authentication required.", "unauthorized") as Response };
  }
  return { userId, session };
}

export async function readJson<T>(request: NextRequest): Promise<T> {
  return (await request.json()) as T;
}

export function forbidden(message = "Forbidden."): Response {
  return problem(403, message, "forbidden");
}
