export class HTTPError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
export function html(value: string, status = 200) {
  return new Response(value, {
    status,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}
export function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export async function readBody(
  request: Request,
  limit: number,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, "invalid_input");
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new HTTPError(413, "request_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    reader.releaseLock();
  }
}
export async function readJSON(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new HTTPError(415, "json_required");
  try {
    const parsed: unknown = JSON.parse(await readBody(request, 65536));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    throw new HTTPError(400, "invalid_json");
  }
}
export function text(value: unknown, max = 255): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new HTTPError(400, "invalid_input");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new HTTPError(400, "invalid_input");
  return value;
}
export const b64url = (data: Uint8Array) =>
  btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export const token = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
// Public links use six case-sensitive base62 characters. Internal IDs above
// retain their original entropy. Rejection sampling avoids modulo bias.
export function shareToken(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let value = "";
    while (value.length < 6) {
      for (const byte of crypto.getRandomValues(new Uint8Array(12))) {
        if (byte < 248) value += alphabet[byte % 62];
        if (value.length === 6) break;
      }
    }
    // This public route is already used by the health endpoint.
    if (value !== "health") return value;
  }
}
export async function hash(value: string) {
  return b64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export async function secretMatches(a: string, b: string) {
  return (await hash(a)) === (await hash(b));
}
