import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashIp } from "@/lib/crypto";

type AuditInput = {
  actorUserId?: string | null;
  orgId?: string | null;
  studyId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  request?: NextRequest;
};

export async function audit(input: AuditInput): Promise<void> {
  const ip =
    input.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    input.request?.headers.get("x-real-ip") ??
    null;

  await prisma.auditEvent.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      orgId: input.orgId ?? null,
      studyId: input.studyId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: input.metadata as Prisma.InputJsonObject | undefined,
      ipHash: hashIp(ip),
      userAgent: input.request?.headers.get("user-agent") ?? null
    }
  });
}
