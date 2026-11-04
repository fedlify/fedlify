/** Small fetch helper shared by the Code & run page and its screens. Errors carry the server's message and code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

export async function apiCall<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error?.message ?? `Request failed (${response.status}).`, response.status, body?.error?.code);
  return body as T;
}
