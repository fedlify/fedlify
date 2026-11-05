import { PREFLIGHT_SH } from "@/lib/site-preflight-script";

// Public on purpose: a site must be able to run this before it has an account, a kit or Docker. It holds no secret.
export const dynamic = "force-static";

export function GET() {
  return new Response(PREFLIGHT_SH, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "content-disposition": 'attachment; filename="preflight.sh"',
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=300"
    }
  });
}
