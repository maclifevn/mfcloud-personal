export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  LICENSE?: Fetcher;
  MODE: "managed" | "personal";
  PUBLIC_ORIGIN: string;
  ADMIN_ORIGIN?: string;
  ADMIN_EMAILS?: string;
  UPLOADS_ENABLED: string;
  BETA_LICENSE_IDS?: string;
  QUOTA_BYTES: string;
  MAX_FILE_BYTES: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  OWNER_TOKEN?: string;
  LICENSE_PUBLIC_KEY_B64?: string;
  LICENSE_SERVICE_SECRET?: string;
  LICENSE_ORIGIN?: string;
}
export interface Principal {
  accountId: string;
  activationId?: string;
}
export interface Share {
  id: string;
  account_id: string;
  request_key: string;
  manifest_hash: string;
  token: string;
  status: "uploading" | "ready" | "deleting" | "deleted";
  bytes: number;
  file_count: number;
  ttl: number;
  source: string;
  created_at: number;
  session_expires_at: number;
  published_at: number | null;
  expires_at: number | null;
  delete_after: number | null;
}
export interface FileRecord {
  id: string;
  share_id: string;
  position: number;
  name: string;
  bytes: number;
  object_key: string;
  status:
    | "pending"
    | "creating"
    | "uploading"
    | "completing"
    | "ready"
    | "deleted";
  multipart_id: string | null;
  lease_until: number;
}
export const PART_BYTES = 16 * 1024 * 1024;
export const TTL_VALUES = [86400, 259200, 604800, 2592000];
export const now = () => Math.floor(Date.now() / 1000);
export function limits(env: Env) {
  const quota = Number(env.QUOTA_BYTES),
    file = Number(env.MAX_FILE_BYTES);
  if (
    !Number.isSafeInteger(quota) ||
    quota <= 0 ||
    !Number.isSafeInteger(file) ||
    file <= 0 ||
    file > 5_000_000_000
  )
    throw new Error("Invalid limits");
  return {
    quotaBytes: env.MODE === "managed" ? 1_000_000_000 : quota,
    maxFileBytes: env.MODE === "managed" ? 500_000_000 : file,
    maxItems: 50,
    maxActiveFiles: 200,
    maxSessions: 2,
    partBytes: PART_BYTES,
  };
}
