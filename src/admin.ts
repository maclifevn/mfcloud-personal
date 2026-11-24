import { adminPage } from "./admin-page";
import { adminScript } from "./admin-client";
import { headers, HTTPError, json, readJSON, text, token } from "./http";
import { now, type Env } from "./types";

const PAGE_SIZE = 25;
const chargedReady =
  "s.status='ready' AND s.expires_at>?1 AND a.status='active'";
const routableCode =
  "length(s.token)=6 AND s.token NOT GLOB '*[^A-Za-z0-9]*' AND s.token<>'health'";
const active = `${chargedReady} AND ${routableCode}`;
const reserved =
  "s.status='uploading' AND s.session_expires_at>?1 AND a.status='active'";
const displayStatus = `CASE WHEN s.status IN ('deleting','deleted') THEN s.status
  WHEN a.status='blocked' THEN 'blocked'
  WHEN (s.status='ready' AND s.expires_at<=?1) OR (s.status='uploading' AND s.session_expires_at<=?1) THEN 'expired'
  WHEN s.status='ready' AND NOT (${routableCode}) THEN 'unavailable'
  ELSE s.status END`;
const shareColumns = `s.rowid AS cursor,s.id,s.account_id,s.token,s.bytes,s.file_count,s.source,
  s.created_at,s.published_at,s.expires_at,s.session_expires_at,s.cleanup_attempts,s.next_cleanup_at,
  ${displayStatus} AS status,
  (SELECT name FROM files WHERE share_id=s.id ORDER BY position LIMIT 1) AS name`;

function pagination(url: URL) {
  const value = url.searchParams.get("cursor");
  const cursor = value === null ? Number.MAX_SAFE_INTEGER : Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 1)
    throw new HTTPError(400, "invalid_cursor");
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > 200 || /[\u0000-\u001f\u007f]/.test(query))
    throw new HTTPError(400, "invalid_search");
  // instr has no D1 LIKE/GLOB pattern limit (50 bytes). It also treats every
  // search character literally; lower preserves the prior ASCII case matching.
  const accountId = url.searchParams.get("accountId") ?? "";
  if (
    accountId &&
    (accountId.length > 200 || /[\u0000-\u001f\u007f]/.test(accountId))
  )
    throw new HTTPError(400, "invalid_account_filter");
  return {
    cursor,
    search: query,
    accountId,
    status: url.searchParams.get("status") ?? "all",
  };
}

async function list(env: Env, url: URL, entity: string) {
  const { cursor, search, status, accountId } = pagination(url),
    timestamp = now();
  let statement: D1PreparedStatement;
  if (entity === "shares") {
    if (
      ![
        "all",
        "ready",
        "uploading",
        "expired",
        "deleting",
        "deleted",
        "blocked",
        "unavailable",
      ].includes(status)
    )
      throw new HTTPError(400, "invalid_status");
    statement = env.DB.prepare(
      `SELECT ${shareColumns} FROM shares s JOIN accounts a ON a.id=s.account_id
      WHERE s.rowid<?2 AND (?5='' OR s.account_id=?5) AND (?4='all' OR (${displayStatus})=?4)
      AND (instr(lower(s.token),lower(?3))>0 OR instr(lower(s.id),lower(?3))>0 OR instr(lower(s.account_id),lower(?3))>0
        OR EXISTS(SELECT 1 FROM files f WHERE f.share_id=s.id AND instr(lower(f.name),lower(?3))>0))
      ORDER BY s.rowid DESC LIMIT ${PAGE_SIZE + 1}`,
    ).bind(timestamp, cursor, search, status, accountId);
  } else if (entity === "accounts") {
    if (!["all", "active", "blocked"].includes(status))
      throw new HTTPError(400, "invalid_status");
    statement = env.DB.prepare(
      `SELECT a.rowid AS cursor,a.id,a.status,a.quota_bytes,a.created_at,
      COALESCE(SUM(CASE WHEN ${chargedReady} THEN s.bytes ELSE 0 END),0) AS usedBytes,
      COALESCE(SUM(CASE WHEN ${reserved} THEN s.bytes ELSE 0 END),0) AS reservedBytes,
      COALESCE(SUM(CASE WHEN ${active} THEN 1 ELSE 0 END),0) AS activeShares
      FROM accounts a LEFT JOIN shares s ON s.account_id=a.id
      WHERE a.rowid<?2 AND instr(lower(a.id),lower(?3))>0 AND (?4='all' OR a.status=?4)
      GROUP BY a.id ORDER BY a.rowid DESC LIMIT ${PAGE_SIZE + 1}`,
    ).bind(timestamp, cursor, search, status);
  } else if (entity === "reports") {
    if (!["all", "active", "closed"].includes(status))
      throw new HTTPError(400, "invalid_status");
    statement = env.DB.prepare(
      `SELECT r.rowid AS cursor,r.id,r.share_id,r.reason,r.created_at,
      s.account_id,s.token,${displayStatus} AS status,
      (SELECT name FROM files WHERE share_id=s.id ORDER BY position LIMIT 1) AS name
      FROM reports r JOIN shares s ON s.id=r.share_id JOIN accounts a ON a.id=s.account_id
      WHERE r.rowid<?2 AND (instr(lower(r.reason),lower(?3))>0 OR instr(lower(s.token),lower(?3))>0
        OR instr(lower(s.account_id),lower(?3))>0 OR instr(lower(r.id),lower(?3))>0)
      AND (?4='all' OR (?4='active' AND (${active})) OR (?4='closed' AND NOT (${active})))
      ORDER BY r.rowid DESC LIMIT ${PAGE_SIZE + 1}`,
    ).bind(timestamp, cursor, search, status);
  } else if (entity === "events") {
    statement = env.DB.prepare(
      `SELECT rowid AS cursor,id,actor,action,target_id,created_at FROM admin_events
      WHERE rowid<?1 AND (instr(lower(actor),lower(?2))>0 OR instr(lower(target_id),lower(?2))>0)
      ORDER BY rowid DESC LIMIT ${PAGE_SIZE + 1}`,
    ).bind(cursor, search);
  } else throw new HTTPError(404, "not_found");
  const rows = (await statement.all<{ cursor: number }>()).results;
  const items = rows.slice(0, PAGE_SIZE);
  return json({
    items,
    nextCursor: rows.length > PAGE_SIZE ? String(items.at(-1)!.cursor) : null,
    serverTime: timestamp,
  });
}

async function overview(env: Env, email: string) {
  const timestamp = now(),
    dayStart = Math.floor(timestamp / 86400) * 86400;
  const results = await env.DB.batch<Record<string, number>>([
    env.DB.prepare(
      `SELECT
      COALESCE(SUM(CASE WHEN ${active} THEN 1 ELSE 0 END),0) AS activeShares,
      COALESCE(SUM(CASE WHEN ${chargedReady} THEN s.bytes ELSE 0 END),0) AS usedBytes,
      COALESCE(SUM(CASE WHEN ${reserved} THEN 1 ELSE 0 END),0) AS uploadingShares,
      COALESCE(SUM(CASE WHEN ${reserved} THEN s.bytes ELSE 0 END),0) AS reservedBytes,
      COALESCE(SUM(CASE WHEN s.status='deleting' THEN 1 ELSE 0 END),0) AS pendingDeletes,
      COALESCE(SUM(CASE WHEN s.status='deleting' THEN s.bytes ELSE 0 END),0) AS pendingDeleteBytes,
      COALESCE(SUM(CASE WHEN s.status='deleting' AND s.cleanup_attempts>0 THEN 1 ELSE 0 END),0) AS retryDeletes,
      COALESCE(SUM(CASE WHEN (s.status='ready' AND s.expires_at<=?1) OR (s.status='uploading' AND s.session_expires_at<=?1) THEN 1 ELSE 0 END),0) AS expiredAwaitingCleanup
      FROM shares s JOIN accounts a ON a.id=s.account_id`,
    ).bind(timestamp),
    env.DB.prepare(
      "SELECT COUNT(*) AS accounts,COALESCE(SUM(status='blocked'),0) AS blockedAccounts FROM accounts",
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS reports,COALESCE(SUM(CASE WHEN ${active} THEN 1 ELSE 0 END),0) AS activeReports
      FROM reports r JOIN shares s ON s.id=r.share_id JOIN accounts a ON a.id=s.account_id`,
    ).bind(timestamp),
    env.DB.prepare(
      `SELECT CAST(published_at/86400 AS INTEGER)*86400 AS day,COUNT(*) AS count
      FROM shares WHERE published_at>=?1 AND published_at<=?2 GROUP BY day ORDER BY day`,
    ).bind(dayStart - 6 * 86400, timestamp),
  ]);
  return json({
    serverTime: timestamp,
    email,
    publicOrigin: env.PUBLIC_ORIGIN,
    stats: {
      ...results[0]!.results[0],
      ...results[1]!.results[0],
      ...results[2]!.results[0],
    },
    activity: Array.from({ length: 7 }, (_, i) => {
      const day = dayStart - (6 - i) * 86400;
      const record = results[3]!.results.find((r) => r.day === day);
      return { day, count: record?.count ?? 0 };
    }),
    operations: {
      uploadsEnabled: env.UPLOADS_ENABLED === "true",
      admission:
        env.MODE === "personal"
          ? "personal"
          : env.BETA_LICENSE_IDS?.trim()
            ? "beta"
            : "licensed",
      cleanupIntervalMinutes: 5,
    },
  });
}

async function mutate(request: Request, env: Env, email: string, path: string) {
  if (request.headers.get("origin") !== env.ADMIN_ORIGIN)
    throw new HTTPError(403, "origin_mismatch");
  const id = text((await readJSON(request)).id, 200),
    timestamp = now();
  let statements: D1PreparedStatement[];
  if (path === "/admin/block-account") {
    if (
      !(await env.DB.prepare("SELECT id FROM accounts WHERE id=?1")
        .bind(id)
        .first())
    )
      throw new HTTPError(404, "not_found");
    statements = [
      env.DB.prepare(
        `INSERT INTO admin_events(id,actor,action,target_id,created_at)
        SELECT ?1,?2,?3,id,?5 FROM accounts WHERE id=?4 AND status='active'`,
      ).bind(token(), email, path, id, timestamp),
      env.DB.prepare(
        "UPDATE accounts SET status='blocked' WHERE id=?1 AND status='active'",
      ).bind(id),
      env.DB.prepare(
        "UPDATE shares SET status='deleting',delete_after=?2 WHERE account_id=?1 AND status IN ('ready','uploading')",
      ).bind(id, timestamp + 1200),
    ];
  } else if (path === "/admin/delete-share") {
    if (
      !(await env.DB.prepare("SELECT id FROM shares WHERE id=?1")
        .bind(id)
        .first())
    )
      throw new HTTPError(404, "not_found");
    statements = [
      env.DB.prepare(
        `INSERT INTO admin_events(id,actor,action,target_id,created_at)
        SELECT ?1,?2,?3,id,?5 FROM shares WHERE id=?4 AND status IN ('ready','uploading')`,
      ).bind(token(), email, path, id, timestamp),
      env.DB.prepare(
        "UPDATE shares SET status='deleting',delete_after=?2 WHERE id=?1 AND status IN ('ready','uploading')",
      ).bind(id, timestamp + 1200),
    ];
  } else throw new HTTPError(404, "not_found");
  // Audit and state changes commit together. Repeated clicks/retries neither
  // extend cleanup grace nor create duplicate audit events for an unchanged target.
  const result = await env.DB.batch(statements);
  return json({ ok: true, changed: result[0]!.meta.changes > 0 });
}

export async function admin(request: Request, env: Env, ctx: ExecutionContext) {
  // Only the Workers Access context is trusted, never client-supplied headers.
  const email = (await ctx.access?.getIdentity())?.email?.trim().toLowerCase();
  if (
    !email ||
    !env.ADMIN_EMAILS?.split(",")
      .map((s) => s.trim().toLowerCase())
      .includes(email)
  )
    throw new HTTPError(403, "admin_required");
  const url = new URL(request.url),
    path = url.pathname;
  if (request.method === "POST") return mutate(request, env, email, path);
  if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
  if (path === "/")
    return new Response(adminPage(email), {
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      },
    });
  if (path === "/admin/app.js")
    return new Response(adminScript, {
      headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
    });
  if (path === "/admin/api/overview") return overview(env, email);
  const detail = path.match(/^\/admin\/api\/shares\/([a-f0-9-]{36})$/);
  if (detail) {
    const share = await env.DB.prepare(
      `SELECT ${shareColumns} FROM shares s JOIN accounts a ON a.id=s.account_id WHERE s.id=?2`,
    )
      .bind(now(), detail[1]!)
      .first();
    if (!share) throw new HTTPError(404, "not_found");
    const files = (
      await env.DB.prepare(
        "SELECT id,name,bytes,status FROM files WHERE share_id=?1 ORDER BY position",
      )
        .bind(detail[1]!)
        .all()
    ).results;
    return json({ share, files });
  }
  const entity = path.match(/^\/admin\/api\/(shares|accounts|reports|events)$/);
  if (entity) return list(env, url, entity[1]!);
  throw new HTTPError(404, "not_found");
}
