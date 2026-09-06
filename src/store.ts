import { hash, HTTPError, integer, text, token } from "./http";
import {
  limits,
  now,
  TTL_VALUES,
  type Env,
  type Share,
  type FileRecord,
  type Principal,
} from "./types";
const charged =
  "((status = 'uploading' AND session_expires_at > ?2) OR (status = 'ready' AND expires_at > ?2))";
export async function ensureAccount(env: Env, id: string) {
  await env.DB.prepare(
    "INSERT INTO accounts(id,quota_bytes,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET quota_bytes=excluded.quota_bytes",
  )
    .bind(id, limits(env).quotaBytes, now())
    .run();
  const account = await env.DB.prepare(
    "SELECT status,quota_bytes FROM accounts WHERE id=?1",
  )
    .bind(id)
    .first<{ status: string; quota_bytes: number }>();
  if (!account || account.status !== "active")
    throw new HTTPError(403, "account_blocked");
  return account;
}
export async function accountUsage(env: Env, id: string) {
  const account = await ensureAccount(env, id);
  const result = await env.DB.prepare(
    `SELECT
  COALESCE(SUM(CASE WHEN status='ready' THEN bytes ELSE 0 END),0) AS usedBytes,
  COALESCE(SUM(CASE WHEN status='uploading' THEN bytes ELSE 0 END),0) AS reservedBytes
  FROM shares WHERE account_id=?1 AND ${charged}`,
  )
    .bind(id, now())
    .first();
  return { quotaBytes: account.quota_bytes, ...result };
}
export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  seconds: number,
) {
  const timestamp = now(),
    window = Math.floor(timestamp / seconds),
    digest = await hash(`${key}:${window}`);
  const result = await env.DB.prepare(
    `INSERT INTO rate_limits(key,count,expires_at) VALUES(?1,1,?2)
  ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ?3`,
  )
    .bind(digest, (window + 1) * seconds, limit)
    .run();
  if (!result.meta.changes) throw new HTTPError(429, "rate_limited");
}
export async function getShare(
  env: Env,
  id: string,
  accountId: string,
): Promise<Share> {
  const share = await env.DB.prepare(
    "SELECT * FROM shares WHERE id=?1 AND account_id=?2",
  )
    .bind(id, accountId)
    .first<Share>();
  if (!share) throw new HTTPError(404, "not_found");
  return share;
}
export function requireUploading(share: Share) {
  if (share.status !== "uploading" || share.session_expires_at <= now())
    throw new HTTPError(409, "upload_expired_or_closed");
}
export async function getFiles(env: Env, shareId: string) {
  return (
    await env.DB.prepare(
      "SELECT * FROM files WHERE share_id=?1 ORDER BY position",
    )
      .bind(shareId)
      .all<FileRecord>()
  ).results;
}
export async function envelope(env: Env, share: Share) {
  const fileRows = await getFiles(env, share.id);
  return {
    id: share.id,
    status: share.status,
    bytes: share.bytes,
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    sessionExpiresAt: share.session_expires_at,
    source: share.source,
    shareURL:
      share.status === "ready" && (share.expires_at ?? 0) > now()
        ? `${env.PUBLIC_ORIGIN}/${share.token}`
        : null,
    files: fileRows.map((f) => ({
      id: f.id,
      position: f.position,
      name: f.name,
      bytes: f.bytes,
      status: f.status,
    })),
  };
}
export async function createUpload(
  env: Env,
  principal: Principal,
  body: Record<string, unknown>,
) {
  const l = limits(env),
    requestKey = text(body.requestKey, 64);
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(requestKey))
    throw new HTTPError(400, "invalid_request_key");
  const ttl = integer(body.ttl, 86400, 2592000);
  if (!TTL_VALUES.includes(ttl)) throw new HTTPError(400, "invalid_expiration");
  const source = text(body.source, 20);
  if (!["finder", "dropTray", "connectionTest"].includes(source))
    throw new HTTPError(400, "invalid_source");
  if (
    !Array.isArray(body.files) ||
    !body.files.length ||
    body.files.length > l.maxItems
  )
    throw new HTTPError(400, "invalid_files");
  const files = body.files.map((input: unknown) => {
    if (!input || typeof input !== "object")
      throw new HTTPError(400, "invalid_files");
    const f = input as Record<string, unknown>,
      name = text(f.name);
    if (/[\\/]/.test(name) || name === "." || name === "..")
      throw new HTTPError(400, "invalid_filename");
    return { name, bytes: integer(f.bytes, 0, l.maxFileBytes) };
  });
  const bytes = files.reduce((s, f) => s + f.bytes, 0),
    digest = await hash(JSON.stringify({ files, ttl, source }));
  const existing = await env.DB.prepare(
    "SELECT * FROM shares WHERE account_id=?1 AND request_key=?2",
  )
    .bind(principal.accountId, requestKey)
    .first<Share>();
  if (existing) {
    if (existing.manifest_hash !== digest)
      throw new HTTPError(409, "idempotency_conflict");
    return envelope(env, existing);
  }
  await ensureAccount(env, principal.accountId);
  await rateLimit(env, `create:${principal.accountId}`, 60, 3600);
  const id = crypto.randomUUID(),
    timestamp = now();
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO shares
  (id,account_id,request_key,manifest_hash,token,bytes,file_count,ttl,source,created_at,session_expires_at)
  SELECT ?3,?1,?4,?5,?6,?7,?8,?9,?10,?2,?11 FROM accounts
  WHERE id=?1 AND status='active'
  AND ?7 + (SELECT COALESCE(SUM(bytes),0) FROM shares WHERE account_id=?1 AND ${charged}) <= quota_bytes
  AND ?8 + (SELECT COALESCE(SUM(file_count),0) FROM shares WHERE account_id=?1 AND ${charged}) <= 200
  AND (SELECT COUNT(*) FROM shares WHERE account_id=?1 AND status='uploading' AND session_expires_at>?2) < 2`,
    ).bind(
      principal.accountId,
      timestamp,
      id,
      requestKey,
      digest,
      token(),
      bytes,
      files.length,
      ttl,
      source,
      timestamp + 86400,
    ),
  ];
  for (const [position, file] of files.entries()) {
    const fileId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO files(id,share_id,position,name,bytes,object_key)
   SELECT ?1,id,?3,?4,?5,?6 FROM shares WHERE id=?2`,
      ).bind(
        fileId,
        id,
        position,
        file.name,
        file.bytes,
        `objects/${id}/${fileId}`,
      ),
    );
  }
  await env.DB.batch(statements);
  const share = await env.DB.prepare(
    "SELECT * FROM shares WHERE account_id=?1 AND request_key=?2",
  )
    .bind(principal.accountId, requestKey)
    .first<Share>();
  if (!share) throw new HTTPError(409, "quota_or_session_limit");
  if (share.manifest_hash !== digest)
    throw new HTTPError(409, "idempotency_conflict");
  return envelope(env, share);
}
export async function deleteShare(env: Env, share: Share) {
  // Keep tombstones and repeatedly delete for 20 minutes: an in-flight R2 completion
  // must not resurrect a cancelled object after the first cleanup attempt.
  await env.DB.prepare(
    "UPDATE shares SET status='deleting',delete_after=?2 WHERE id=?1 AND status NOT IN ('deleting','deleted')",
  )
    .bind(share.id, now() + 1200)
    .run();
}
export async function publish(env: Env, share: Share) {
  if (share.status === "ready") return envelope(env, share);
  requireUploading(share);
  const timestamp = now();
  const result = await env.DB.prepare(
    `UPDATE shares SET status='ready',published_at=?2,expires_at=?2+ttl
  WHERE id=?1 AND status='uploading' AND session_expires_at>?2
  AND EXISTS(SELECT 1 FROM accounts WHERE id=shares.account_id AND status='active')
  AND (SELECT COUNT(*) FROM files WHERE share_id=?1 AND status='ready')=file_count`,
  )
    .bind(share.id, timestamp)
    .run();
  const fresh = await getShare(env, share.id, share.account_id);
  if (!result.meta.changes && fresh.status !== "ready")
    throw new HTTPError(409, "upload_incomplete_or_closed");
  return envelope(env, fresh);
}
