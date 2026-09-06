import {
  S3Client,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { HTTPError, integer, text } from "./http";
import { getShare, requireUploading } from "./store";
import {
  PART_BYTES,
  now,
  type Env,
  type FileRecord,
  type Share,
} from "./types";
function client(env: Env) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
    // Workers uses fetch even when nodejs_compat makes the SDK select its Node runtime.
    requestHandler: new FetchHttpHandler({ requestTimeout: 60000 }),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
async function file(env: Env, share: Share, id: string) {
  const value = await env.DB.prepare(
    "SELECT * FROM files WHERE id=?1 AND share_id=?2",
  )
    .bind(id, share.id)
    .first<FileRecord>();
  if (!value) throw new HTTPError(404, "not_found");
  return value;
}
async function acquire(
  env: Env,
  f: FileRecord,
  state: "creating" | "completing",
) {
  const r = await env.DB.prepare(
    `UPDATE files SET status=?2,lease_until=?3 WHERE id=?1
  AND status!='ready' AND (lease_until<=?4)
  AND EXISTS(SELECT 1 FROM shares WHERE id=files.share_id AND status='uploading' AND session_expires_at>?4)`,
  )
    .bind(f.id, state, now() + 120, now())
    .run();
  if (!r.meta.changes) throw new HTTPError(409, "operation_in_progress");
}
async function begin(
  env: Env,
  share: Share,
  f: FileRecord,
): Promise<FileRecord> {
  if (f.multipart_id) return f;
  if (!f.bytes) return f;
  await acquire(env, f, "creating");
  // Unknown creation outcomes are not retried automatically. The bucket lifecycle
  // aborts unrecorded upload IDs; they never receive signed part URLs.
  const result = await client(env).send(
    new CreateMultipartUploadCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: f.object_key,
      ContentType: "application/octet-stream",
      CacheControl: "no-store",
    }),
  );
  if (!result.UploadId) throw new HTTPError(502, "storage_unavailable");
  await env.DB.prepare(
    "UPDATE files SET multipart_id=?2,status='uploading',lease_until=0 WHERE id=?1",
  )
    .bind(f.id, result.UploadId)
    .run();
  return {
    ...f,
    multipart_id: result.UploadId,
    status: "uploading",
    lease_until: 0,
  };
}
export async function signParts(
  env: Env,
  share: Share,
  id: string,
  body: Record<string, unknown>,
) {
  requireUploading(share);
  let f = await file(env, share, id);
  if (f.status === "ready" || f.bytes === 0) return { parts: [] };
  if (f.lease_until > now()) throw new HTTPError(409, "operation_in_progress");
  if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 3)
    throw new HTTPError(400, "invalid_parts");
  const requested = body.parts.map((p) => {
    if (!p || typeof p !== "object") throw new HTTPError(400, "invalid_parts");
    const number = integer(p.number, 1, Math.ceil(f.bytes / PART_BYTES));
    const bytes = integer(p.bytes, 1, PART_BYTES),
      md5 = text(p.md5, 24);
    if (
      bytes !== Math.min(PART_BYTES, f.bytes - (number - 1) * PART_BYTES) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(md5)
    )
      throw new HTTPError(400, "invalid_parts");
    return { number, bytes, md5 };
  });
  f = await begin(env, share, f);
  const signed = [];
  for (const p of requested) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO parts(file_id,number,bytes,md5) VALUES(?1,?2,?3,?4)",
    )
      .bind(f.id, p.number, p.bytes, p.md5)
      .run();
    const stored = await env.DB.prepare(
      "SELECT md5,bytes FROM parts WHERE file_id=?1 AND number=?2",
    )
      .bind(f.id, p.number)
      .first<{ md5: string; bytes: number }>();
    if (stored?.md5 !== p.md5 || stored.bytes !== p.bytes)
      throw new HTTPError(409, "source_changed");
    const url = await getSignedUrl(
      client(env),
      new UploadPartCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: f.object_key,
        UploadId: f.multipart_id!,
        PartNumber: p.number,
        ContentLength: p.bytes,
        ContentMD5: p.md5,
      }),
      {
        expiresIn: 900,
        signableHeaders: new Set(["content-length", "content-md5"]),
      },
    );
    signed.push({
      number: p.number,
      url,
      headers: { "Content-Length": String(p.bytes), "Content-MD5": p.md5 },
      expiresAt: now() + 900,
    });
  }
  requireUploading(await getShare(env, share.id, share.account_id));
  return { parts: signed };
}
export async function listUploadedParts(env: Env, f: FileRecord) {
  if (!f.multipart_id || f.status === "ready") return [];
  const parts = [];
  let marker: string | undefined;
  do {
    const result = await client(env).send(
      new ListPartsCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: f.object_key,
        UploadId: f.multipart_id,
        PartNumberMarker: marker,
      }),
    );
    parts.push(...(result.Parts ?? []));
    marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}
export async function completeFile(env: Env, share: Share, id: string) {
  let f = await file(env, share, id);
  if (f.status === "ready") return { ok: true };
  requireUploading(share);
  await acquire(env, f, "completing");
  try {
    let object = await env.BUCKET.head(f.object_key);
    if (!object && f.bytes === 0) {
      await env.BUCKET.put(f.object_key, new Uint8Array(), {
        httpMetadata: {
          contentType: "application/octet-stream",
          cacheControl: "no-store",
        },
      });
      object = await env.BUCKET.head(f.object_key);
    }
    if (!object) {
      if (!f.multipart_id) throw new HTTPError(409, "upload_incomplete");
      const parts = await listUploadedParts(env, f);
      const expected = (
        await env.DB.prepare(
          "SELECT number,bytes,md5 FROM parts WHERE file_id=?1 ORDER BY number",
        )
          .bind(f.id)
          .all<{ number: number; bytes: number; md5: string }>()
      ).results;
      if (
        parts.length !== Math.ceil(f.bytes / PART_BYTES) ||
        expected.length !== parts.length
      )
        throw new HTTPError(409, "upload_incomplete");
      for (const [index, p] of parts.entries()) {
        const e = expected[index]!;
        const hex = Array.from(atob(e.md5), (c) =>
          c.charCodeAt(0).toString(16).padStart(2, "0"),
        ).join("");
        if (
          p.PartNumber !== e.number ||
          p.Size !== e.bytes ||
          p.ETag?.replaceAll('"', "") !== hex
        )
          throw new HTTPError(409, "integrity_mismatch");
      }
      await client(env).send(
        new CompleteMultipartUploadCommand({
          Bucket: env.R2_BUCKET_NAME,
          Key: f.object_key,
          UploadId: f.multipart_id,
          MultipartUpload: {
            Parts: parts.map((p) => ({
              PartNumber: p.PartNumber,
              ETag: p.ETag,
            })),
          },
        }),
      );
      object = await env.BUCKET.head(f.object_key);
    }
    if (!object || object.size !== f.bytes)
      throw new HTTPError(409, "integrity_mismatch");
    await env.DB.prepare(
      "UPDATE files SET status='ready',lease_until=0 WHERE id=?1",
    )
      .bind(f.id)
      .run();
    requireUploading(await getShare(env, share.id, share.account_id));
    return { ok: true };
  } catch (error) {
    await env.DB.prepare("UPDATE files SET lease_until=0 WHERE id=?1")
      .bind(f.id)
      .run();
    throw error;
  }
}
export async function removeObject(env: Env, f: FileRecord) {
  if (f.multipart_id) {
    try {
      await client(env).send(
        new AbortMultipartUploadCommand({
          Bucket: env.R2_BUCKET_NAME,
          Key: f.object_key,
          UploadId: f.multipart_id,
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "NoSuchUpload") throw error;
    }
  }
  await env.BUCKET.delete(f.object_key);
}
