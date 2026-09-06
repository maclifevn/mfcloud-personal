import { escape, headers, html, HTTPError, json, text, token } from "./http";
import { getFiles, rateLimit } from "./store";
import { now, type Env, type Share } from "./types";
export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · MFCloud</title><style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;background:#f4f6fa;color:#192534;margin:0;padding:32px 16px}main{max-width:640px;margin:5vh auto;background:white;border:1px solid #e1e6ee;border-radius:24px;padding:32px}h1{font-size:26px}p,small{color:#596779;line-height:1.6}ul{padding:0;list-style:none}li{border-top:1px solid #e8edf3;padding:18px 0;display:flex;align-items:center;gap:16px;justify-content:space-between}strong{overflow-wrap:anywhere}a,button{color:#1468d4}a{white-space:nowrap}button{background:#1468d4;color:white;border:0;border-radius:9px;padding:10px 18px;cursor:pointer}textarea{width:100%;box-sizing:border-box;border:1px solid #cad2df;border-radius:8px;padding:12px;font:inherit}.brand{font-weight:700;color:#536a8b;font-size:14px}footer{margin-top:28px;font-size:13px;color:#596779}</style></head><body><main><div class="brand">MFCloud · MFinder</div>${body}</main></body></html>`;
export async function publicShare(env: Env, shareToken: string) {
  const share = await env.DB.prepare(
    `SELECT shares.* FROM shares JOIN accounts ON accounts.id=shares.account_id
  WHERE token=?1 AND accounts.status='active' AND shares.status='ready' AND shares.expires_at>?2`,
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
) {
  const f = (await getFiles(env, share.id)).find(
    (f) => f.id === fileId && f.status === "ready",
  );
  if (!f) throw new HTTPError(404, "not_found");
  const h = new Headers({
    ...headers,
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
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
function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  const divisor = bytes < 1_000_000 ? 1000 : 1_000_000;
  return `${(bytes / divisor).toLocaleString("en", { maximumFractionDigits: 2 })} ${divisor === 1000 ? "KB" : "MB"}`;
}
export async function sharePage(env: Env, share: Share) {
  const files = await getFiles(env, share.id);
  const rows = files
    .map(
      (f) =>
        `<li><div><strong>${escape(f.name)}</strong><br><small>${formatBytes(f.bytes)}</small></div><a href="/${share.token}/files/${f.id}" download>Download</a></li>`,
    )
    .join("");
  return html(
    page(
      "Shared files",
      `<h1>${files.length === 1 ? "A file for you" : `${files.length} files for you`}</h1><p>Available until ${escape(new Date(share.expires_at! * 1000).toUTCString())}.</p><ul>${rows}</ul><footer>Only open files from people you trust. <a href="/${share.token}/report">Report abuse</a></footer>`,
    ),
  );
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
