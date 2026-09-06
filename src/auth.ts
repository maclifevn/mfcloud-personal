import { HTTPError, secretMatches } from "./http";
import { now, type Env, type Principal } from "./types";
function decode(value: string) {
  const s = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Principal> {
  const bearer = request.headers
    .get("authorization")
    ?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer) throw new HTTPError(401, "authentication_required");
  if (env.MODE === "personal") {
    if (
      !env.OWNER_TOKEN ||
      env.OWNER_TOKEN.length < 32 ||
      !(await secretMatches(bearer, env.OWNER_TOKEN))
    )
      throw new HTTPError(401, "invalid_token");
    return { accountId: "owner" };
  }
  try {
    const [prefix, payload, signature, ...extra] = bearer.split(".");
    if (
      prefix !== "mc1" ||
      !payload ||
      !signature ||
      extra.length ||
      !env.LICENSE_PUBLIC_KEY_B64
    )
      throw new Error();
    const key = await crypto.subtle.importKey(
      "raw",
      decode(env.LICENSE_PUBLIC_KEY_B64),
      "Ed25519",
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        decode(signature),
        new TextEncoder().encode(`mc1.${payload}`),
      ))
    )
      throw new Error();
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (
      claims.aud !== "mfcloud" ||
      typeof claims.sub !== "string" ||
      typeof claims.activationId !== "string" ||
      !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.iat) ||
      claims.exp <= now() ||
      claims.iat > now() + 30 ||
      claims.exp - claims.iat > 900
    )
      throw new Error();
    return { accountId: claims.sub, activationId: claims.activationId };
  } catch {
    throw new HTTPError(401, "invalid_token");
  }
}
export async function checkUploadAccess(env: Env, principal: Principal) {
  if (env.UPLOADS_ENABLED !== "true")
    throw new HTTPError(503, "uploads_disabled");
  if (env.MODE === "personal") return;
  const beta =
    env.BETA_LICENSE_IDS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (beta.length && !beta.includes(principal.accountId))
    throw new HTTPError(403, "beta_not_enabled");
  if (!env.LICENSE || !env.LICENSE_SERVICE_SECRET || !env.LICENSE_ORIGIN)
    throw new HTTPError(503, "license_unavailable");
  const response = await env.LICENSE.fetch(
    new Request(`${env.LICENSE_ORIGIN}/internal/mfcloud/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.LICENSE_SERVICE_SECRET}`,
      },
      body: JSON.stringify(principal),
    }),
  );
  if (!response.ok)
    throw new HTTPError(
      response.status === 403 ? 403 : 503,
      response.status === 403 ? "license_required" : "license_unavailable",
    );
}
