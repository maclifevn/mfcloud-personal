import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  createUpload,
  accountUsage,
  publish,
  deleteShare,
  getShare,
} from "../src/store";
import { cleanup } from "../src/cleanup";
import { authenticate, checkUploadAccess } from "../src/auth";
import { b64url } from "../src/http";
import { signParts } from "../src/storage";
import worker from "../src/index";
export function database(sqlite) {
  function prepare(sql, values = []) {
    const args = Object.fromEntries(values.map((v, i) => [String(i + 1), v]));
    const all = () => sqlite.prepare(sql).all(args);
    const execute = () => {
      const s = sqlite.prepare(sql);
      const rows = s.columns().length ? s.all(args) : [];
      const result = rows.length
        ? { changes: sqlite.prepare("SELECT changes() AS n").get().n }
        : s.columns().length
          ? { changes: 0 }
          : s.run(args);
      return {
        success: true,
        results: rows,
        meta: { changes: Number(result.changes) },
      };
    };
    return {
      bind: (...v) => prepare(sql, v),
      first: async () => all()[0] ?? null,
      all: async () => ({ results: all() }),
      run: async () => execute(),
      execute,
    };
  }
  return {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
describe("MFCloud quota and publication", () => {
  let sqlite, env;
  const principal = { accountId: "owner" };
  const request = (key = "request_00000000001", bytes = 400_000_000) => ({
    requestKey: key,
    ttl: 604800,
    source: "finder",
    files: [{ name: "photo.raw", bytes }],
  });
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      readFileSync(
        new URL("../migrations/0001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    env = {
      DB: database(sqlite),
      MODE: "personal",
      QUOTA_BYTES: "1000000000",
      MAX_FILE_BYTES: "500000000",
      PUBLIC_ORIGIN: "https://share.test",
      UPLOADS_ENABLED: "true",
      OWNER_TOKEN: "x".repeat(40),
      R2_ACCOUNT_ID: "fixture",
      R2_BUCKET_NAME: "fixture",
      R2_ACCESS_KEY_ID: "fixture",
      R2_SECRET_ACCESS_KEY: "fixture",
    };
  });
  afterEach(() => sqlite.close());
  it("limits token guessing per IP without creating a counter for each token", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_788_670_000_000);
    const logging = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let index = 0; index < 241; index++) {
        const token = index.toString(36).padStart(22, "a");
        const response = await worker.fetch(
          new Request(`${env.PUBLIC_ORIGIN}/${token}`, {
            headers: { "cf-connecting-ip": "192.0.2.10" },
          }),
          env,
          {},
        );
        expect(response.status).toBe(index < 240 ? 410 : 429);
      }
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n,
      ).toBe(1);
      const otherIP = await worker.fetch(
        new Request(`${env.PUBLIC_ORIGIN}/${"b".repeat(22)}`, {
          headers: { "cf-connecting-ip": "192.0.2.11" },
        }),
        env,
        {},
      );
      expect(otherIP.status).toBe(410);
    } finally {
      logging.mockRestore();
      clock.mockRestore();
    }
  });
  it("creates multipart sessions through fetch in the Worker runtime", async () => {
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>fixture</Bucket><Key>fixture</Key><UploadId>session</UploadId></InitiateMultipartUploadResult>',
          { headers: { "Content-Type": "application/xml" } },
        ),
      );
    try {
      const upload = await createUpload(env, principal, request(undefined, 3));
      const share = await getShare(env, upload.id, "owner");
      const result = await signParts(env, share, upload.files[0].id, {
        parts: [{ number: 1, bytes: 3, md5: "kAFQmDzST7DWlj99KOF/cg==" }],
      });
      expect(transport).toHaveBeenCalledTimes(1);
      const sent = transport.mock.calls[0][0];
      expect(sent.method).toBe("POST");
      expect(new URL(sent.url).hostname).toContain("r2.cloudflarestorage.com");
      expect(new URL(result.parts[0].url).searchParams.get("uploadId")).toBe(
        "session",
      );
    } finally {
      transport.mockRestore();
    }
  });
  it("serializes concurrent reservations and counts pending bytes", async () => {
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        createUpload(env, principal, request(`request_0000000000${i}`)),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await accountUsage(env, "owner")).reservedBytes).toBe(800_000_000);
  });
  it("idempotent requests return one share and reject changed manifests", async () => {
    const a = await createUpload(env, principal, request()),
      b = await createUpload(env, principal, request());
    expect(a.id).toBe(b.id);
    await expect(
      createUpload(env, principal, request(undefined, 1)),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await accountUsage(env, "owner")).reservedBytes).toBe(400_000_000);
  });
  it("requires every file before publishing and starts TTL at publication", async () => {
    const upload = await createUpload(env, principal, request());
    let share = await getShare(env, upload.id, "owner");
    await expect(publish(env, share)).rejects.toMatchObject({
      code: "upload_incomplete_or_closed",
    });
    sqlite.prepare("UPDATE files SET status='ready'").run();
    const published = await publish(env, share);
    expect(published.shareURL).toMatch(
      /^https:\/\/share.test\/[A-Za-z0-9_-]{22}$/,
    );
    expect(published.expiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 604795,
    );
    expect((await accountUsage(env, "owner")).usedBytes).toBe(400_000_000);
    share = await getShare(env, upload.id, "owner");
    expect((await publish(env, share)).shareURL).toBe(published.shareURL);
  });
  it("cancel and expiry immediately release logical quota without resurrecting shares", async () => {
    const upload = await createUpload(env, principal, request()),
      share = await getShare(env, upload.id, "owner");
    await deleteShare(env, share);
    await deleteShare(env, share);
    sqlite.prepare("UPDATE files SET status='ready'").run();
    await expect(publish(env, share)).rejects.toMatchObject({
      code: "upload_incomplete_or_closed",
    });
    expect((await accountUsage(env, "owner")).reservedBytes).toBe(0);
    await createUpload(env, principal, request("request_00000000002"));
    sqlite
      .prepare(
        "UPDATE shares SET session_expires_at=0 WHERE status='uploading'",
      )
      .run();
    expect((await accountUsage(env, "owner")).reservedBytes).toBe(0);
  });
  it.each([500_000_001, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid byte count %s",
    async (bytes) => {
      await expect(
        createUpload(env, principal, request(undefined, bytes)),
      ).rejects.toBeDefined();
      expect(sqlite.prepare("SELECT count(*) AS n FROM shares").get().n).toBe(
        0,
      );
    },
  );
  it("signs exact part length and checksum and refuses altered retry checksum", async () => {
    const upload = await createUpload(env, principal, request(undefined, 3));
    const share = await getShare(env, upload.id, "owner"),
      id = upload.files[0].id;
    sqlite
      .prepare(
        "UPDATE files SET status='uploading',multipart_id='fixture-upload'",
      )
      .run();
    const body = {
      parts: [{ number: 1, bytes: 3, md5: "kAFQmDzST7DWlj99KOF/cg==" }],
    };
    const signed = await signParts(env, share, id, body),
      url = new URL(signed.parts[0].url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-length",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-md5",
    );
    await expect(
      signParts(env, share, id, { parts: [{ ...body.parts[0], bytes: 4 }] }),
    ).rejects.toMatchObject({ code: "invalid_parts" });
    await expect(
      signParts(env, share, id, {
        parts: [{ ...body.parts[0], md5: "AAAAAAAAAAAAAAAAAAAAAA==" }],
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
  it("requires authentication and rejects forged admin headers", async () => {
    const ctx = { waitUntil: () => {} };
    expect(
      (
        await worker.fetch(
          new Request("https://share.test/api/v1/account"),
          env,
          ctx,
        )
      ).status,
    ).toBe(401);
    env.ADMIN_ORIGIN = "https://admin.test";
    env.ADMIN_EMAILS = "owner@test";
    expect(
      (
        await worker.fetch(
          new Request("https://admin.test", {
            headers: { "Cf-Access-Authenticated-User-Email": "owner@test" },
          }),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
  });
  it("accepts the exact decimal quota boundary and rejects the next byte", async () => {
    await createUpload(
      env,
      principal,
      request("request_00000000001", 500_000_000),
    );
    await createUpload(
      env,
      principal,
      request("request_00000000002", 500_000_000),
    );
    expect((await accountUsage(env, "owner")).reservedBytes).toBe(
      1_000_000_000,
    );
    await expect(
      createUpload(env, principal, request("request_00000000003", 1)),
    ).rejects.toMatchObject({ code: "quota_or_session_limit" });
  });
  it("serves escaped attachments and rejects new Range requests after expiry or revocation", async () => {
    const input = request(undefined, 6);
    input.files[0].name = '<script>alert("x")<.svg';
    const upload = await createUpload(env, principal, input),
      share = await getShare(env, upload.id, "owner");
    sqlite.prepare("UPDATE files SET status='ready'").run();
    const published = await publish(env, share);
    const ctx = { waitUntil: () => {} },
      bytes = new TextEncoder().encode("abcdef");
    env.BUCKET = {
      head: async () => ({ size: 6, httpEtag: '"fixture"' }),
      get: async (_key, options) => ({
        body: options
          ? bytes.slice(
              options.range.offset,
              options.range.offset + options.range.length,
            )
          : bytes,
      }),
    };
    const page = await worker.fetch(new Request(published.shareURL), env, ctx);
    const html = await page.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    const url = `${published.shareURL}/files/${upload.files[0].id}`;
    const response = await worker.fetch(
      new Request(url, { headers: { Range: "bytes=1-3" } }),
      env,
      ctx,
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("bcd");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toContain(
      "attachment;",
    );
    expect(response.headers.get("Content-Range")).toBe("bytes 1-3/6");
    expect(
      (
        await worker.fetch(
          new Request(url, { headers: { Range: "bytes=99-" } }),
          env,
          ctx,
        )
      ).status,
    ).toBe(416);
    expect(
      (
        await worker.fetch(new Request(url, { method: "HEAD" }), env, ctx)
      ).headers.get("Content-Length"),
    ).toBe("6");
    sqlite.prepare("UPDATE shares SET expires_at=0").run();
    expect(
      (
        await worker.fetch(
          new Request(url, { headers: { Range: "bytes=0-1" } }),
          env,
          ctx,
        )
      ).status,
    ).toBe(410);
    sqlite
      .prepare("UPDATE shares SET expires_at=?")
      .run(Math.floor(Date.now() / 1000) + 1000);
    await deleteShare(env, share);
    expect((await worker.fetch(new Request(url), env, ctx)).status).toBe(410);
  });
  it("backs off failed physical deletes without losing the tombstone or logical quota", async () => {
    const upload = await createUpload(env, principal, request(undefined, 5)),
      share = await getShare(env, upload.id, "owner");
    await deleteShare(env, share);
    sqlite.prepare("UPDATE shares SET delete_after=0").run();
    env.BUCKET = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error("storage unavailable"))
        .mockResolvedValue(undefined),
    };
    await cleanup(env);
    expect((await getShare(env, upload.id, "owner")).status).toBe("deleting");
    expect((await accountUsage(env, "owner")).reservedBytes).toBe(0);
    await cleanup(env);
    expect(env.BUCKET.delete).toHaveBeenCalledTimes(1);
    sqlite.prepare("UPDATE shares SET next_cleanup_at=0").run();
    await cleanup(env);
    await cleanup(env);
    expect((await getShare(env, upload.id, "owner")).status).toBe("deleted");
    expect(env.BUCKET.delete).toHaveBeenCalledTimes(2);
  });
  it("validates token audience and expiry and rechecks disabled licenses before writes", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    env.MODE = "managed";
    env.LICENSE_PUBLIC_KEY_B64 = b64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const make = async (overrides = {}) => {
      const claims = {
        aud: "mfcloud",
        sub: "paid-license",
        activationId: "device",
        iat: timestamp,
        exp: timestamp + 900,
        ...overrides,
      };
      const payload = b64url(new TextEncoder().encode(JSON.stringify(claims))),
        message = `mc1.${payload}`;
      const signature = b64url(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            keys.privateKey,
            new TextEncoder().encode(message),
          ),
        ),
      );
      return new Request("https://share.test/api/v1/account", {
        headers: { authorization: `Bearer ${message}.${signature}` },
      });
    };
    expect((await authenticate(await make(), env)).accountId).toBe(
      "paid-license",
    );
    await expect(
      authenticate(await make({ aud: "mfinder" }), env),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      authenticate(await make({ exp: timestamp - 1 }), env),
    ).rejects.toMatchObject({ code: "invalid_token" });
    env.LICENSE_ORIGIN = "https://license.test";
    env.LICENSE_SERVICE_SECRET = "fixture";
    env.LICENSE = { fetch: async () => new Response(null, { status: 403 }) };
    await expect(
      checkUploadAccess(env, {
        accountId: "paid-license",
        activationId: "device",
      }),
    ).rejects.toMatchObject({ code: "license_required" });
  });
});
