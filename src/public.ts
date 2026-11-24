import { headers, html, HTTPError, json, text, token } from "./http";
import { getFiles, rateLimit } from "./store";
import { now, type Env, type Share } from "./types";
export { page } from "./recipient";
import { recipientPage } from "./recipient";
import { isPreviewCandidate, previewMime } from "./image-preview";
export async function publicShare(env: Env, shareToken: string) {
  const share = await env.DB.prepare(
    `SELECT shares.* FROM shares JOIN accounts ON accounts.id=shares.account_id
  WHERE token=?1 AND accounts.status='active' AND (
    (shares.status='ready' AND shares.expires_at>?2)
    OR (shares.status='uploading' AND shares.session_expires_at>?2))`,
  )
    .bind(shareToken, now())
    .first<Share>();
  if (!share) throw new HTTPError(410, "share_unavailable");
  return share;
}
export async function download(
  request: Request,
  env: Env,
  share: Share,
  fileId: string,
  inlineImage = false,
) {
  const f = (await getFiles(env, share.id)).find(
    (f) => f.id === fileId && f.status === "ready",
  );
  if (!f) throw new HTTPError(404, "not_found");
  const mime = inlineImage ? await previewMime(env, f) : null;
  if (inlineImage && !mime)
    throw new HTTPError(415, "image_preview_unavailable");
  const h = new Headers({
    ...headers,
    "Content-Type": mime ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${inlineImage ? "inline" : "attachment"}; filename="${inlineImage ? "image" : "download"}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  });
  const object = await env.BUCKET.head(f.object_key);
  if (!object) throw new HTTPError(410, "share_unavailable");
  h.set("ETag", object.httpEtag);
  const range = request.headers.get("range");
  let offset = 0,
    length = object.size,
    status = 200;
  if (
    range &&
    (!request.headers.get("if-range") ||
      request.headers.get("if-range") === object.httpEtag)
  ) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2]) || !object.size)
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${object.size}` },
      });
    if (!match[1]) {
      length = Math.min(Number(match[2]), object.size);
      offset = object.size - length;
    } else {
      offset = Number(match[1]);
      const end = match[2]
        ? Math.min(Number(match[2]), object.size - 1)
        : object.size - 1;
      length = end - offset + 1;
    }
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      offset >= object.size ||
      length <= 0
    )
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${object.size}` },
      });
    status = 206;
    h.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
  }
  h.set("Content-Length", String(length));
  if (request.method === "HEAD")
    return new Response(null, { status, headers: h });
  const data = await env.BUCKET.get(
    f.object_key,
    status === 206 ? { range: { offset, length } } : undefined,
  );
  if (!data) throw new HTTPError(410, "share_unavailable");
  return new Response(data.body, { status, headers: h });
}
export async function sharePage(env: Env, share: Share, language = "en") {
  const files = await getFiles(env, share.id);
  const locale = language.trim().toLowerCase().startsWith("vi") ? "vi" : "en";
  const candidate = files.find(
    (file) => file.status === "ready" && isPreviewCandidate(file.name),
  );
  let mime: string | null = null;
  if (candidate) {
    try {
      mime = await previewMime(env, candidate);
    } catch {
      /* A preview probe must not prevent access to the download page. */
    }
  }
  const preview =
    candidate && mime
      ? { ...candidate, mime, origin: env.PUBLIC_ORIGIN }
      : undefined;
  const response = html(recipientPage(share, files, locale, preview));
  response.headers.set("Content-Language", locale);
  response.headers.set("Vary", "Accept-Language");
  return response;
}
export async function report(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
) {
  await rateLimit(
    env,
    `report:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    5,
    3600,
  );
  const share = await publicShare(env, text(body.token, 22));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (
    !reason ||
    reason.length > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)
  ) {
    throw new HTTPError(400, "invalid_report");
  }
  await env.DB.prepare(
    "INSERT INTO reports(id,share_id,reason,created_at) VALUES(?1,?2,?3,?4)",
  )
    .bind(token(), share.id, reason, now())
    .run();
  return json({ ok: true });
}
