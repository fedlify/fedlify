import argon2 from "argon2";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { hashIp } from "@/lib/crypto";
import { ensureUserDefaults } from "@/lib/defaults";
import { json, problem } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(200)
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "local";
  if (!rateLimit(`register:${hashIp(ip) ?? ip}`, 5, 10 * 60 * 1000)) {
    return problem(429, "Too many registration attempts.", "rate_limited");
  }

  const parsed = registerSchema.safeParse(await request.json());
  if (!parsed.success) {
    return problem(400, parsed.error.issues[0]?.message ?? "Invalid registration request.");
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    return problem(409, "An account already exists for this email.", "email_exists");
  }

  const passwordHash = await argon2.hash(parsed.data.password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1
  });

  const user = await prisma.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash
    }
  });

  await ensureUserDefaults(prisma, user.id);
  await audit({
    actorUserId: user.id,
    action: "auth.register",
    targetType: "User",
    targetId: user.id,
    request
  });

  return json({ id: user.id, email: user.email }, { status: 201 });
}
