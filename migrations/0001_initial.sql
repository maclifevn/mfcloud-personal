PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
 id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked')),
 quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0), created_at INTEGER NOT NULL
);
CREATE TABLE shares (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), request_key TEXT NOT NULL,
 manifest_hash TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','ready','deleting','deleted')),
 bytes INTEGER NOT NULL CHECK(bytes >= 0), file_count INTEGER NOT NULL CHECK(file_count BETWEEN 1 AND 50),
 ttl INTEGER NOT NULL CHECK(ttl IN (86400,259200,604800,2592000)), source TEXT NOT NULL CHECK(source IN ('finder','dropTray','connectionTest')),
 created_at INTEGER NOT NULL, session_expires_at INTEGER NOT NULL, published_at INTEGER, expires_at INTEGER,
 delete_after INTEGER, next_cleanup_at INTEGER NOT NULL DEFAULT 0, cleanup_attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(account_id, request_key)
);
CREATE INDEX shares_account_usage ON shares(account_id,status,expires_at,session_expires_at);
CREATE INDEX shares_cleanup ON shares(status,delete_after,expires_at,session_expires_at);
CREATE INDEX shares_cleanup_retry ON shares(status,next_cleanup_at);
CREATE TABLE files (
 id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id), position INTEGER NOT NULL,
 name TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), object_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','creating','uploading','completing','ready','deleted')),
 multipart_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, UNIQUE(share_id,position)
);
CREATE INDEX files_share ON files(share_id,position);
CREATE TABLE parts (
 file_id TEXT NOT NULL REFERENCES files(id), number INTEGER NOT NULL CHECK(number > 0),
 bytes INTEGER NOT NULL CHECK(bytes > 0), md5 TEXT NOT NULL, PRIMARY KEY(file_id,number)
);
CREATE TABLE reports (id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE admin_events (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
