import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { database } from "./database.js";
import worker from "../src/index";
import { adminScript } from "../src/admin-client";
import { createUpload } from "../src/store";
import { now } from "../src/types";

describe("Access-protected MFCloud dashboard", () => {
  let sqlite, env, ctx;
  const call = (
    path = "/",
    init = {},
    context = ctx,
    origin = env.ADMIN_ORIGIN,
  ) => worker.fetch(new Request(origin + path, init), env, context);
  const post = (path, id, origin = env.ADMIN_ORIGIN) =>
    call(path, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  const upload = async (
    key = 1,
    accountId = "owner",
    name = "photo.png",
    bytes = 123,
  ) =>
    createUpload(
      env,
      { accountId },
      {
        requestKey: "admin_fixture_" + String(key).padStart(8, "0"),
        ttl: 604800,
        source: "finder",
        files: [{ name, bytes }],
      },
    );
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(1788685200000);
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
      PUBLIC_ORIGIN: "https://share.test",
      ADMIN_ORIGIN: "https://admin.test",
      ADMIN_EMAILS: "Owner@Example.test",
      UPLOADS_ENABLED: "true",
      QUOTA_BYTES: "1000000000",
      MAX_FILE_BYTES: "500000000",
    };
    ctx = {
      access: { getIdentity: async () => ({ email: "owner@example.test" }) },
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });
  it("A25B-001 every rendered Accounts filter is accepted by its entity API", async () => {
    const elements = new Map(),
      listeners = new Map();
    const element = (id) => {
      if (!elements.has(id))
        elements.set(id, {
          innerHTML: "",
          parentElement: {},
          dataset: {},
          classList: { toggle() {} },
          addEventListener() {},
          setAttribute() {},
          removeAttribute() {},
        });
      return elements.get(id);
    };
    const document = {
      getElementById: element,
      documentElement: { dataset: {} },
      querySelectorAll: () => [],
      addEventListener: (kind, callback) => listeners.set(kind, callback),
    };
    new Script(adminScript).runInNewContext({
      document,
      Intl,
      URL,
      URLSearchParams,
      AbortController,
      fetch: () => new Promise(() => {}),
      setTimeout: () => 1,
      clearTimeout() {},
      localStorage: { getItem: () => null },
    });
    const navigate = (view) =>
      listeners.get("click")({
        target: { closest: () => ({ dataset: { view } }) },
      });
    navigate("accounts");
    const accounts = [
      ...element("status").innerHTML.matchAll(/value="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(accounts.length).toBeGreaterThan(0);
    for (const status of accounts)
      expect(
        (await call("/admin/api/accounts?status=" + status)).status,
        status,
      ).toBe(200);
    navigate("shares");
    expect(element("status").innerHTML).toContain('value="unavailable"');
    expect((await call("/admin/api/shares?status=unavailable")).status).toBe(
      200,
    );
  });

  it("requires a trusted Access identity for HTML, script, reads and mutations; spoofed headers never suffice", async () => {
    for (const path of [
      "/",
      "/admin/app.js",
      "/admin/api/overview",
      "/admin/api/shares",
    ]) {
      const response = await call(
        path,
        {
          headers: {
            "cf-access-authenticated-user-email": "owner@example.test",
          },
        },
        {},
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("admin_required");
      expect(
        (
          await call(
            path,
            {},
            {
              access: {
                getIdentity: async () => ({ email: "stranger@example.test" }),
              },
            },
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await call(
          "/admin/delete-share",
          {
            method: "POST",
            headers: {
              origin: env.ADMIN_ORIGIN,
              "content-type": "application/json",
            },
            body: '{"id":"x"}',
          },
          {},
        )
      ).status,
    ).toBe(403);
  });
  it("isolates admin routes from the public host and returns bounded JSON errors", async () => {
    for (const path of ["/admin/app.js", "/admin/api/overview"])
      expect((await call(path, {}, ctx, env.PUBLIC_ORIGIN)).status).toBe(404);
    expect((await call("/unknown")).status).toBe(404);
    expect((await call("/admin/api/shares?cursor=-1")).status).toBe(400);
    expect((await call("/admin/api/shares?status=malicious")).status).toBe(400);
    expect((await call("/admin/api/shares?q=" + "x".repeat(201))).status).toBe(
      400,
    );
  });
  it("serves a self-contained dashboard with strict CSP and no secret or external script", async () => {
    const response = await call();
    const html = await response.text();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(html).toContain('lang="vi"');
    expect(html).toContain('src="/admin/app.js"');
    expect(html).not.toMatch(/<script(?! src=)/);
    expect(html).not.toContain("R2_SECRET");
    const script = await call("/admin/app.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(() => new Script(adminScript)).not.toThrow();
    expect(await script.text()).toBe(adminScript);
  });
  it("escapes even an allowlisted identity before rendering HTML", async () => {
    const email = "owner+<img src=x onerror=alert(1)>@example.test";
    env.ADMIN_EMAILS = email;
    const response = await call(
      "/",
      {},
      { access: { getIdentity: async () => ({ email }) } },
    );
    const html = await response.text();
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
  it("separates live bytes, reservations, expired records and cleanup; includes zero activity days", async () => {
    const ready = await upload(1);
    const waiting = await upload(2);
    sqlite
      .prepare(
        "UPDATE shares SET status='ready',published_at=?,expires_at=? WHERE id=?",
      )
      .run(now() - 86400, now() + 86400, ready.id);
    const expired = await upload(3, "other", "expired.txt", 50);
    sqlite
      .prepare("UPDATE shares SET session_expires_at=? WHERE id=?")
      .run(now(), expired.id);
    const deleting = await upload(4, "other", "pending.txt", 70);
    sqlite
      .prepare(
        "UPDATE shares SET status='deleting',cleanup_attempts=1 WHERE id=?",
      )
      .run(deleting.id);
    sqlite
      .prepare("INSERT INTO reports VALUES('report',?,'Investigate',?)")
      .run(ready.id, now());
    const data = await (await call("/admin/api/overview")).json();
    expect(data.stats).toMatchObject({
      activeShares: 1,
      usedBytes: 123,
      reservedBytes: 123,
      uploadingShares: 1,
      pendingDeletes: 1,
      pendingDeleteBytes: 70,
      retryDeletes: 1,
      expiredAwaitingCleanup: 1,
      accounts: 2,
      reports: 1,
      activeReports: 1,
    });
    expect(data.activity).toHaveLength(7);
    expect(data.activity.reduce((s, d) => s + d.count, 0)).toBe(1);
    expect(data.activity.at(-1).count).toBe(0);
    const accounts = await (await call("/admin/api/accounts")).json();
    expect(accounts.items.find((a) => a.id === "owner")).toMatchObject({
      usedBytes: 123,
      reservedBytes: 123,
      activeShares: 1,
    });
    expect(waiting.id).toBeTruthy();
  });
  it("paginates deterministically at identical timestamps and treats SQL wildcards literally", async () => {
    for (let i = 1; i <= 27; i++)
      await upload(
        i,
        "account" + i,
        i === 9 ? "100%_complete.txt" : "file.txt",
      );
    const first = await (await call("/admin/api/shares")).json();
    expect(first.items).toHaveLength(25);
    const second = await (
      await call("/admin/api/shares?cursor=" + first.nextCursor)
    ).json();
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((s) => s.id)).size,
    ).toBe(27);
    const search = await (
      await call("/admin/api/shares?q=" + encodeURIComponent("%_"))
    ).json();
    expect(search.items).toHaveLength(1);
    expect(search.items[0].name).toBe("100%_complete.txt");
    const injection = await (
      await call("/admin/api/shares?q=" + encodeURIComponent("' OR 1=1 --"))
    ).json();
    expect(injection.items).toHaveLength(0);
  });
  it("returns file details without object keys, multipart IDs or signed URLs", async () => {
    const item = await upload(1, "owner", '<svg onload="alert(1)">.txt');
    const data = await (await call("/admin/api/shares/" + item.id)).json();
    expect(data.files[0].name).toContain("<svg"); // Remains data, escaped by the UI.
    expect(Object.keys(data.files[0]).sort()).toEqual([
      "bytes",
      "id",
      "name",
      "status",
    ]);
    expect(JSON.stringify(data)).not.toContain("object_key");
    expect(JSON.stringify(data)).not.toContain("multipart_id");
  });
  it("supports long Vietnamese searches under D1's 50-byte LIKE pattern limit", async () => {
    const query = "Tài liệu nhận diện thương hiệu cho mùa thu năm 2026";
    const item = await upload(1, query, query + ".pdf");
    sqlite
      .prepare("INSERT INTO reports VALUES('r',?,?,?)")
      .run(item.id, query, now());
    sqlite
      .prepare(
        "INSERT INTO admin_events VALUES('e','owner@example.test','/admin/delete-share',?,?)",
      )
      .run(query, now());
    // Confirmed against real D1. Desktop SQLite's default limit is much larger,
    // which previously allowed these failing production queries to pass tests.
    sqlite.function("like", { varargs: true }, (pattern) => {
      if (Buffer.byteLength(pattern) > 50)
        throw new Error("LIKE or GLOB pattern too complex");
      return 0;
    });
    for (const entity of ["shares", "accounts", "reports", "events"]) {
      const response = await call(
        "/admin/api/" + entity + "?q=" + encodeURIComponent(query),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).items).toHaveLength(1);
    }
  });
  it("scopes account navigation exactly even when another account or filename contains that ID", async () => {
    const own = await upload(1, "owner"),
      other = await upload(2, "owner-extra"),
      named = await upload(3, "different", "owner.txt");
    const response = await call("/admin/api/shares?accountId=owner");
    expect((await response.json()).items.map((item) => item.id)).toEqual([
      own.id,
    ]);
    expect(
      (await (await call("/admin/api/shares?accountId=owner&q=absent")).json())
        .items,
    ).toHaveLength(0);
    expect(
      (await call("/admin/api/shares?accountId=" + "x".repeat(201))).status,
    ).toBe(400);
    expect(other.id).not.toBe(named.id);
  });
  it("does not call retired codes live links but preserves their stored-byte charge and revocation", async () => {
    const old = await upload(1),
      current = await upload(2);
    sqlite
      .prepare("UPDATE shares SET status='ready',published_at=?,expires_at=?")
      .run(now(), now() + 604800);
    sqlite
      .prepare("UPDATE shares SET token='retired22charactercode1' WHERE id=?")
      .run(old.id);
    sqlite
      .prepare("INSERT INTO reports VALUES('r',?,'Old link',?)")
      .run(old.id, now());
    const overview = await (await call("/admin/api/overview")).json();
    expect(overview.stats).toMatchObject({
      activeShares: 1,
      usedBytes: 246,
      activeReports: 0,
    });
    const list = await (
      await call("/admin/api/shares?status=unavailable")
    ).json();
    expect(list.items.map((item) => item.id)).toEqual([old.id]);
    const accounts = await (await call("/admin/api/accounts")).json();
    expect(accounts.items[0]).toMatchObject({
      activeShares: 1,
      usedBytes: 246,
    });
    expect(
      (await (await call("/admin/api/shares/" + current.id)).json()).share
        .status,
    ).toBe("ready");
    expect((await post("/admin/delete-share", old.id)).status).toBe(200);
  });
  it("requires same-origin JSON for mutation and validates the exact target", async () => {
    const item = await upload();
    expect(
      (await post("/admin/delete-share", item.id, "https://evil.test")).status,
    ).toBe(403);
    expect(
      (
        await call("/admin/delete-share", {
          method: "POST",
          headers: { origin: env.ADMIN_ORIGIN, "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect((await call("/admin/delete-share")).status).toBe(404);
    expect((await post("/admin/block-account", "missing")).status).toBe(404);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM admin_events").get().n,
    ).toBe(0);
    expect(
      sqlite.prepare("SELECT status FROM shares WHERE id=?").get(item.id)
        .status,
    ).toBe("uploading");
  });
  it("revokes only the selected share, audits once, and does not extend grace on retry", async () => {
    const first = await upload(1),
      second = await upload(2);
    expect(
      (await (await post("/admin/delete-share", first.id)).json()).changed,
    ).toBe(true);
    const grace = sqlite
      .prepare("SELECT delete_after FROM shares WHERE id=?")
      .get(first.id).delete_after;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100000);
    expect(
      (await (await post("/admin/delete-share", first.id)).json()).changed,
    ).toBe(false);
    expect(
      sqlite.prepare("SELECT delete_after FROM shares WHERE id=?").get(first.id)
        .delete_after,
    ).toBe(grace);
    expect(
      sqlite.prepare("SELECT status FROM shares WHERE id=?").get(second.id)
        .status,
    ).toBe("uploading");
    const events = await (await call("/admin/api/events")).json();
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({
      actor: "owner@example.test",
      action: "/admin/delete-share",
      target_id: first.id,
    });
  });
  it("blocks only the selected account, closes all its live shares, and keeps reports inspectable", async () => {
    const first = await upload(1),
      second = await upload(2),
      other = await upload(3, "other");
    sqlite
      .prepare("UPDATE shares SET status='ready',expires_at=? WHERE id=?")
      .run(now() + 10, first.id);
    sqlite
      .prepare("INSERT INTO reports VALUES('r',?,'Fixture',?)")
      .run(first.id, now());
    expect((await post("/admin/block-account", "owner")).status).toBe(200);
    expect(
      (await (await post("/admin/block-account", "owner")).json()).changed,
    ).toBe(false);
    expect(
      sqlite.prepare("SELECT status FROM accounts WHERE id=?").get("owner")
        .status,
    ).toBe("blocked");
    for (const id of [first.id, second.id])
      expect(
        sqlite.prepare("SELECT status FROM shares WHERE id=?").get(id).status,
      ).toBe("deleting");
    expect(
      sqlite.prepare("SELECT status FROM shares WHERE id=?").get(other.id)
        .status,
    ).toBe("uploading");
    expect(
      (await (await call("/admin/api/reports?status=active")).json()).items,
    ).toHaveLength(0);
    expect(
      (await (await call("/admin/api/reports?status=closed")).json()).items,
    ).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM admin_events").get().n,
    ).toBe(1);
  });
  it("rolls back a mutation if its audit cannot be committed", async () => {
    const item = await upload();
    sqlite.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON admin_events BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    expect((await post("/admin/delete-share", item.id)).status).toBe(500);
    expect(
      sqlite.prepare("SELECT status FROM shares WHERE id=?").get(item.id)
        .status,
    ).toBe("uploading");
  });
  it("rolls back the audit and account lock when the share update fails", async () => {
    const item = await upload();
    sqlite.exec(
      "CREATE TRIGGER reject_share_change BEFORE UPDATE ON shares BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    expect((await post("/admin/block-account", "owner")).status).toBe(500);
    expect(
      sqlite.prepare("SELECT status FROM accounts WHERE id='owner'").get()
        .status,
    ).toBe("active");
    expect(
      sqlite.prepare("SELECT status FROM shares WHERE id=?").get(item.id)
        .status,
    ).toBe("uploading");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM admin_events").get().n,
    ).toBe(0);
  });
  it("concurrent retries produce one revocation and one audit event", async () => {
    const item = await upload();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post("/admin/delete-share", item.id)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const results = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM admin_events").get().n,
    ).toBe(1);
    expect(
      sqlite.prepare("SELECT status FROM shares WHERE id=?").get(item.id)
        .status,
    ).toBe("deleting");
  });
});
