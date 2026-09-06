import { authenticate, checkUploadAccess } from "./auth";
import { cleanup } from "./cleanup";
import {
  escape,
  html,
  HTTPError,
  json,
  readJSON,
  readBody,
  text,
  token,
} from "./http";
import {
  accountUsage,
  createUpload,
  deleteShare,
  ensureAccount,
  envelope,
  getFiles,
  getShare,
  publish,
  rateLimit,
} from "./store";
import { completeFile, signParts, listUploadedParts } from "./storage";
import { download, page, publicShare, report, sharePage } from "./public";
import { limits, now, TTL_VALUES, type Env, type Share } from "./types";
async function admin(request: Request, env: Env, ctx: ExecutionContext) {
  const access = (
    ctx as unknown as {
      access?: { getIdentity: () => Promise<{ email?: string }> };
    }
  ).access;
  const identity = await access?.getIdentity(),
    email = identity?.email?.trim().toLowerCase();
  if (
    !email ||
    !env.ADMIN_EMAILS?.split(",")
      .map((s) => s.trim().toLowerCase())
      .includes(email)
  )
    throw new HTTPError(403, "admin_required");
  const path = new URL(request.url).pathname;
  if (request.method === "POST") {
    if (request.headers.get("origin") !== env.ADMIN_ORIGIN)
      throw new HTTPError(403, "origin_mismatch");
    const body = await readJSON(request),
      id = text(body.id, 200);
    if (path === "/admin/block-account") {
      await env.DB.batch([
        env.DB.prepare("UPDATE accounts SET status='blocked' WHERE id=?1").bind(
          id,
        ),
        env.DB.prepare(
          "UPDATE shares SET status='deleting',delete_after=?2 WHERE account_id=?1 AND status IN ('ready','uploading')",
        ).bind(id, now() + 1200),
      ]);
    } else if (path === "/admin/delete-share") {
      const share = await env.DB.prepare("SELECT * FROM shares WHERE id=?1")
        .bind(id)
        .first<Share>();
      if (!share) throw new HTTPError(404, "not_found");
      await deleteShare(env, share);
    } else throw new HTTPError(404, "not_found");
    await env.DB.prepare(
      "INSERT INTO admin_events(id,actor,action,target_id,created_at) VALUES(?1,?2,?3,?4,?5)",
    )
      .bind(token(), email, path, id, now())
      .run();
    return json({ ok: true });
  }
  if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
  const reports = (
    await env.DB.prepare(
      "SELECT * FROM reports ORDER BY created_at DESC LIMIT 100",
    ).all()
  ).results;
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS pendingDeletes,COALESCE(SUM(bytes),0) AS pendingDeleteBytes FROM shares WHERE status='deleting'",
  ).first();
  return json({
    reports,
    stats,
    actions: [
      "POST /admin/block-account {id}",
      "POST /admin/delete-share {id}",
    ],
  });
}
async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url),
    path = url.pathname;
  if (env.ADMIN_ORIGIN && url.origin === env.ADMIN_ORIGIN)
    return admin(request, env, ctx);
  if (
    url.origin !== env.PUBLIC_ORIGIN &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new HTTPError(404, "not_found");
  if (path === "/health" && request.method === "GET")
    return json({ ok: true, protocolVersion: 1 });
  if (path === "/api/v1/capabilities" && request.method === "GET")
    return json({
      protocolVersion: 1,
      provider: env.MODE,
      uploadsEnabled: env.UPLOADS_ENABLED === "true",
      expirations: TTL_VALUES,
      ...limits(env),
    });
  if (path === "/api/v1/reports" && request.method === "POST")
    return report(request, env, await readJSON(request));
  const publicMatch = path.match(
    /^\/([A-Za-z0-9]{6})(?:\/(files\/([a-f0-9-]{36})|report))?$/,
  );
  if (publicMatch) {
    const shareToken = publicMatch[1]!;
    await rateLimit(
      env,
      // One IP budget across all links: changing a guessed token must not
      // bypass throttling or allocate a fresh D1 counter on every request.
      `public:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
      240,
      60,
    );
    const share = await publicShare(env, shareToken);
    if (publicMatch[2] === "report") {
      if (request.method === "GET")
        return html(
          page(
            "Report abuse",
            `<section class="report-card"><h1>Report abuse</h1><p>Tell us what is wrong with this share.</p><form method="post"><textarea name="reason" maxlength="2000" required aria-label="Reason"></textarea><p><button>Send report</button></p></form></section>`,
          ),
        );
      if (request.method === "POST") {
        if (
          request.headers.get("origin") !== url.origin ||
          request.headers.get("content-type")?.split(";")[0] !==
            "application/x-www-form-urlencoded"
        )
          throw new HTTPError(400, "invalid_report");
        const body = new URLSearchParams(await readBody(request, 8192));
        await report(request, env, {
          token: shareToken,
          reason: body.get("reason"),
        });
        return html(
          page(
            "Report received",
            '<section class="report-card"><h1>Report received</h1><p>Thank you. Your report will be reviewed.</p></section>',
          ),
        );
      }
    }
    if (!["GET", "HEAD"].includes(request.method))
      throw new HTTPError(405, "method_not_allowed");
    if (publicMatch[3]) return download(request, env, share, publicMatch[3]);
    const response = await sharePage(
      env,
      share,
      request.headers.get("accept-language") ?? "en",
    );
    return request.method === "HEAD"
      ? new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      : response;
  }
  if (!path.startsWith("/api/v1/")) throw new HTTPError(404, "not_found");
  const principal = await authenticate(request, env);
  await ensureAccount(env, principal.accountId);
  await rateLimit(env, `api:${principal.accountId}`, 600, 60);
  if (path === "/api/v1/account" && request.method === "GET")
    return json(await accountUsage(env, principal.accountId));
  if (path === "/api/v1/uploads" && request.method === "POST") {
    await checkUploadAccess(env, principal);
    return json(await createUpload(env, principal, await readJSON(request)));
  }
  if (path === "/api/v1/shares" && request.method === "GET") {
    const cursor = url.searchParams.get("cursor") ?? "",
      after = cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(after))
      throw new HTTPError(400, "invalid_cursor");
    // SQLite rowid is a stable unique cursor even when timestamps coincide.
    const rows = (
      await env.DB.prepare(
        "SELECT rowid AS cursor,shares.* FROM shares WHERE account_id=?1 AND published_at IS NOT NULL AND created_at<=?2 AND rowid<?3 ORDER BY rowid DESC LIMIT 50",
      )
        .bind(principal.accountId, now(), after)
        .all<Share & { cursor: number }>()
    ).results;
    return json({
      shares: await Promise.all(rows.map((s) => envelope(env, s))),
      nextCursor: rows.length === 50 ? String(rows.at(-1)!.cursor) : null,
    });
  }
  const match = path.match(
    /^\/api\/v1\/(uploads|shares)\/([a-f0-9-]{36})(?:\/(complete|files\/([a-f0-9-]{36})\/(parts|complete)))?$/,
  );
  if (match) {
    const share = await getShare(env, match[2]!, principal.accountId);
    if (!match[3] && request.method === "DELETE") {
      if (match[1] === "uploads") {
        await env.DB.prepare(
          "UPDATE shares SET status='deleting',delete_after=?2 WHERE id=?1 AND status='uploading'",
        )
          .bind(share.id, now() + 1200)
          .run();
      } else {
        await deleteShare(env, share);
      }
      ctx.waitUntil(cleanup(env));
      return json({ ok: true });
    }
    if (match[1] === "uploads") {
      if (!match[3] && request.method === "GET") {
        const result = await envelope(env, share),
          files = await getFiles(env, share.id);
        const extended = [];
        for (const f of files) {
          let numbers: number[] = [];
          let status = f.status;
          if (
            share.status === "uploading" &&
            f.multipart_id &&
            f.status !== "ready"
          ) {
            try {
              numbers = (await listUploadedParts(env, f))
                .map((p) => p.PartNumber!)
                .filter(Number.isSafeInteger);
            } catch (error) {
              if ((error as { name?: string }).name !== "NoSuchUpload")
                throw error;
              // CompleteMultipartUpload may succeed before its response/checkpoint is lost.
              // Only the server can create a final object at this private key.
              if (await env.BUCKET.head(f.object_key)) {
                await completeFile(env, share, f.id);
                status = "ready";
              } else throw new HTTPError(409, "upload_expired_or_closed");
            }
          }
          extended.push({
            ...result.files.find((row) => row.id === f.id)!,
            status,
            uploadedParts: numbers,
          });
        }
        return json({ ...result, files: extended });
      }
      if (request.method === "POST") {
        await checkUploadAccess(env, principal);
        if (match[3] === "complete") return json(await publish(env, share));
        if (match[4] && match[5] === "parts")
          return json(
            await signParts(env, share, match[4], await readJSON(request)),
          );
        if (match[4] && match[5] === "complete")
          return json(await completeFile(env, share, match[4]));
      }
    }
  }
  throw new HTTPError(404, "not_found");
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (env.MODE === "personal" && !env.PUBLIC_ORIGIN)
      env = { ...env, PUBLIC_ORIGIN: new URL(request.url).origin };
    const requestId = crypto.randomUUID(),
      start = Date.now();
    let response: Response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      const status = error instanceof HTTPError ? error.status : 500,
        code = error instanceof HTTPError ? error.code : "internal_error";
      if (status >= 500) {
        const name = error instanceof Error ? error.name : "UnknownError";
        console.error(
          JSON.stringify({
            event: "request_error",
            requestId,
            errorType: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
              ? name
              : "Error",
            missingGlobal:
              error instanceof ReferenceError
                ? /\b([A-Za-z_$][A-Za-z0-9_$]{0,63}) is not defined\b/.exec(
                    error.message,
                  )?.[1]
                : undefined,
            locations:
              error instanceof Error
                ? error.stack?.match(/index\.js:\d+:\d+/g)?.slice(0, 3)
                : undefined,
          }),
        );
      }
      response = new URL(request.url).pathname.startsWith("/api/")
        ? json({ error: code, requestId }, status)
        : html(
            page(
              "Unavailable",
              `<h1>This link is unavailable</h1><p>${escape(code)}</p>`,
            ),
            status,
          );
    }
    response.headers.set("X-Request-ID", requestId);
    console.log(
      JSON.stringify({
        event: "request",
        requestId,
        status: response.status,
        durationMs: Date.now() - start,
      }),
    );
    return response;
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
