import { requireUser } from "@/lib/api";
import { json } from "@/lib/json";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const authResult = await requireUser();
  if ("response" in authResult) return authResult.response;

  const user = await prisma.user.findUnique({
    where: { id: authResult.userId },
    include: {
      profile: true,
      orgMemberships: {
        include: { organization: true }
      },
      studyMembers: {
        include: {
          study: {
            include: { organization: true }
          }
        }
      }
    }
  });

  return json({ user });
}
