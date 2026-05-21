import { json } from "@/lib/json";

export async function GET() {
  return json({ ok: true, service: "fedlify-web" });
}
