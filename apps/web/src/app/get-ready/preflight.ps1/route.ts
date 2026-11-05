import { PREFLIGHT_PS1 } from "@/lib/site-preflight-script";

// Public on purpose (see preflight.sh). Served as text so a browser shows or saves it and never runs it.
export const dynamic = "force-static";

export function GET() {
  return new Response(PREFLIGHT_PS1, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="preflight.ps1"',
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=300"
    }
  });
}
