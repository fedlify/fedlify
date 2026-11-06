/**
 * Backfill existing assistant proposals into agent threads. Idempotent.
 *
 *   cd apps/web && npx tsx scripts/backfill-agent-threads.ts --dry-run
 *   cd apps/web && npx tsx scripts/backfill-agent-threads.ts
 *
 * Needs DATABASE_URL. Uses relative imports so no path-alias loader is required. Legacy rows (files = null) and
 * template agent sessions are untouched; older Ask chats were never stored and cannot be recovered.
 */

import { PrismaClient } from "@prisma/client";
import { backfillAgentThreads } from "../src/lib/agent-backfill";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = new PrismaClient();
  try {
    const result = await backfillAgentThreads(db, { dryRun, log: (line) => console.log(line) });
    console.log(JSON.stringify(result));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
