import { randomToken, sha256 } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

// One-time download grants. A successful password step-up mints exactly one grant for one package; redeeming it
// (atomically, once) yields exactly one presigned URL. Only the sha256 of the grant token is stored.

export const DOWNLOAD_GRANT_TTL_MS = 2 * 60 * 1000;
export const PRESIGNED_URL_SECONDS = 300;
export const KIT_VALID_MS = 7 * 24 * 60 * 60 * 1000;

/** The stored hash covers the user who passed step-up, so only that same user can redeem the token. */
function grantHash(userId: string, token: string): string {
  return sha256(`${userId}:${token}`);
}

export async function mintDownloadGrant(packageId: string, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + DOWNLOAD_GRANT_TTL_MS);
  await prisma.siteJoinPackage.update({
    where: { id: packageId },
    data: { downloadGrantHash: grantHash(userId, token), downloadGrantExpiresAt: expiresAt }
  });
  return { token, expiresAt };
}

/** True exactly once per minted grant: the conditional update clears the hash, so a replay or a race finds nothing. */
export async function redeemDownloadGrant(packageId: string, userId: string, token: string): Promise<boolean> {
  const result = await prisma.siteJoinPackage.updateMany({
    where: { id: packageId, downloadGrantHash: grantHash(userId, token), downloadGrantExpiresAt: { gt: new Date() } },
    data: { downloadGrantHash: null, downloadGrantExpiresAt: null, downloadCount: { increment: 1 } }
  });
  return result.count === 1;
}

/** Package fields safe to return to the browser (no grant hash). */
export function publicPackage<T extends { downloadGrantHash?: unknown; downloadGrantExpiresAt?: unknown }>(
  pkg: T
): Omit<T, "downloadGrantHash" | "downloadGrantExpiresAt"> {
  const { downloadGrantHash: _hash, downloadGrantExpiresAt: _expires, ...rest } = pkg;
  void _hash;
  void _expires;
  return rest;
}
