import { NextResponse } from "next/server";

export function serializeForJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Date) return item.toISOString();
      return item;
    })
  );
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(serializeForJson(data), init);
}

export function problem(status: number, message: string, code = "bad_request"): NextResponse {
  return json({ error: { code, message } }, { status });
}
