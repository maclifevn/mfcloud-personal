import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { database } from "./database.js";
import { createUpload, getShare, publish, deleteShare } from "../src/store";
import worker from "../src/index";

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe("public image previews", () => {
  let sqlite, env;
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
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  async function fixture(name, bytes = png) {
    const upload = await createUpload(
      env,
      { accountId: "owner" },
      {
        requestKey: "preview_request_00001",
        ttl: 604800,
        source: "finder",
        files: [{ name, bytes: bytes.length }],
      },
    );
    sqlite.prepare("UPDATE files SET status='ready'").run();
    sqlite.prepare("UPDATE shares SET token='Ab3xY9'").run();
    const share = await getShare(env, upload.id, "owner");
    const published = await publish(env, share);
    env.BUCKET = {
      head: vi.fn(async () => ({
        size: bytes.length,
        httpEtag: '"image-fixture"',
      })),
      get: vi.fn(async (_key, options) => {
        const body = options?.range
          ? bytes.slice(
              options.range.offset,
              options.range.offset + options.range.length,
            )
          : bytes;
        return {
          body,
          arrayBuffer: async () =>
            body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength,
            ),
        };
      }),
    };
    const fetch = (suffix = "", init = {}) =>
      worker.fetch(new Request(published.shareURL + suffix, init), env, {});
    return { share, fetch, path: `/files/${upload.files[0].id}/preview` };
  }

  it.each(["Screenshot.png", 'Scrolling capture "<image>".PNG'])(
    "renders %s with an inline image, full-size link and absolute crawler metadata",
    async (name) => {
      const { fetch, path } = await fixture(name);
      const response = await fetch("", {
        headers: { "Accept-Language": "vi" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<img src="/Ab3xY9${path}"`);
      expect(html).toContain(`href="/Ab3xY9${path}" target="_blank"`);
      expect(html).toContain(
        `property="og:image" content="https://share.test/Ab3xY9${path}"`,
      );
      expect(html).toContain('property="og:image:type" content="image/png"');
      expect(html).toContain(
        'property="og:url" content="https://share.test/Ab3xY9"',
      );
      expect(html).toContain("Xem ảnh kích thước gốc");
      expect(html).not.toContain('"<image>"');
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "img-src 'self'",
      );
      const image = await fetch(path);
      expect(image.status).toBe(200);
      expect(image.headers.get("Content-Type")).toBe("image/png");
      expect(image.headers.get("Content-Disposition")).toContain("inline;");
      expect(image.headers.get("Cache-Control")).toBe("no-store");
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
      const head = await fetch(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Type")).toBe("image/png");
      expect(head.headers.get("Content-Length")).toBe(String(png.length));
      expect(await head.text()).toBe("");
      const range = await fetch(path, { headers: { Range: "bytes=0-7" } });
      expect(range.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(
        png.slice(0, 8),
      );
      const attachment = await fetch(path.replace("/preview", ""));
      expect(attachment.headers.get("Content-Disposition")).toContain(
        "attachment;",
      );
      expect(attachment.headers.get("Content-Type")).toBe(
        "application/octet-stream",
      );
    },
  );

  it.each(["expired", "revoked", "disabled"])(
    "blocks %s previews and HEAD before reading object storage",
    async (state) => {
      const { share, fetch, path } = await fixture("Capture.png");
      if (state === "expired")
        sqlite.prepare("UPDATE shares SET expires_at=0").run();
      if (state === "revoked") await deleteShare(env, share);
      if (state === "disabled")
        sqlite.prepare("UPDATE accounts SET status='blocked'").run();
      for (const method of ["GET", "HEAD"]) {
        expect((await fetch(path, { method })).status).toBe(410);
        expect((await fetch("", { method })).status).toBe(410);
      }
      expect(env.BUCKET.get).not.toHaveBeenCalled();
      expect(env.BUCKET.head).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "HEAD"])(
    "keeps the download page available on %s when the optional preview probe fails",
    async (method) => {
      const { fetch, path } = await fixture("Capture.png");
      env.BUCKET.get.mockRejectedValueOnce(
        new Error("temporary preview storage failure"),
      );
      const page = await fetch("", { method });
      expect(page.status).toBe(200);
      if (method === "GET") {
        const html = await page.text();
        expect(html).toContain(
          `href="/Ab3xY9${path.replace("/preview", "")}" download`,
        );
        expect(html).not.toContain("<img");
        expect(html).not.toContain('property="og:image"');
      }
      const attachment = await fetch(path.replace("/preview", ""));
      expect(attachment.status).toBe(200);
      expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(png);
    },
  );

  it.each([
    [
      "renamed.png",
      new TextEncoder().encode("<html><script>alert(1)</script></html>"),
    ],
    ["vector.svg", new TextEncoder().encode("<svg onload='alert(1)'/>")],
    ["empty.png", new Uint8Array()],
  ])(
    "keeps %s as an attachment and refuses inline active or empty content",
    async (name, bytes) => {
      const { fetch, path } = await fixture(name, bytes);
      const html = await (await fetch()).text();
      expect(html).not.toContain("<img");
      expect(html).not.toContain('property="og:image"');
      expect((await fetch(path)).status).toBe(415);
      expect((await fetch(path, { method: "HEAD" })).status).toBe(415);
      expect(
        (await fetch(path.replace("/preview", ""))).headers.get(
          "Content-Disposition",
        ),
      ).toContain("attachment;");
    },
  );

  it.each([
    ["photo.jpg", [255, 216, 255, 224], "image/jpeg"],
    ["animation.gif", [71, 73, 70, 56, 57, 97], "image/gif"],
    [
      "picture.webp",
      [82, 73, 70, 70, 20, 0, 0, 0, 87, 69, 66, 80],
      "image/webp",
    ],
  ])(
    "uses verified %s bytes to select the MIME type",
    async (name, bytes, mime) => {
      const { fetch, path } = await fixture(name, new Uint8Array(bytes));
      expect((await fetch(path)).headers.get("Content-Type")).toBe(mime);
    },
  );
});
