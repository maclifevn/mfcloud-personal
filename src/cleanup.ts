import { getFiles } from "./store";
import { removeObject } from "./storage";
import { now, type Env, type Share } from "./types";
export async function cleanup(env: Env) {
  const timestamp = now();
  await env.DB.prepare(
    `UPDATE shares SET status='deleting',delete_after=?1+1200 WHERE
  (status='uploading' AND session_expires_at<=?1) OR (status='ready' AND expires_at<=?1)`,
  )
    .bind(timestamp)
    .run();
  const due = (
    await env.DB.prepare(
      "SELECT * FROM shares WHERE status='deleting' AND next_cleanup_at<=?1 ORDER BY next_cleanup_at,COALESCE(delete_after,0) LIMIT 25",
    )
      .bind(timestamp)
      .all<Share & { cleanup_attempts: number }>()
  ).results;
  for (const share of due) {
    let success = true;
    for (const f of await getFiles(env, share.id)) {
      if (f.lease_until > timestamp) {
        success = false;
        continue;
      }
      try {
        await removeObject(env, f);
      } catch {
        success = false;
        console.warn(
          JSON.stringify({ event: "cleanup_retry", shareId: share.id }),
        );
      }
    }
    if (success && (share.delete_after ?? Infinity) <= timestamp) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE files SET status='deleted' WHERE share_id=?1",
        ).bind(share.id),
        env.DB.prepare(
          "UPDATE shares SET status='deleted' WHERE id=?1 AND status='deleting'",
        ).bind(share.id),
      ]);
    } else {
      const attempts = success ? 0 : share.cleanup_attempts + 1;
      const delay = success
        ? 300
        : Math.min(3600, 300 * 2 ** Math.min(attempts, 4));
      await env.DB.prepare(
        "UPDATE shares SET cleanup_attempts=?2,next_cleanup_at=?3 WHERE id=?1 AND status='deleting'",
      )
        .bind(share.id, attempts, timestamp + delay)
        .run();
    }
  }
  await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<=?1")
    .bind(timestamp)
    .run();
  console.log(JSON.stringify({ event: "cleanup", processed: due.length }));
}
