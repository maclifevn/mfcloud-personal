# MFCloud Personal

Run your own private Cloudflare R2 storage for MFinder → Quick Share. Files stay
in your Cloudflare account. The Mac app receives a connection token, never your
R2 access keys. Cloudflare usage is billed to your account.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maclifevn/mfcloud-personal)

The button copies this template into your GitHub account and configures a Worker,
private R2 bucket and D1 database. Review the proposed resource names before
deploying. `R2_BUCKET_NAME` must match the bucket bound as `BUCKET`; provide the
bucket-scoped R2 credentials and a separate `OWNER_TOKEN` as Worker secrets.
If the bucket does not yet exist when creating its restricted API token, use the
manual setup below to create it first. After deployment, complete the lifecycle
and MFinder connection steps below. See Cloudflare's
[deployment button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

### Manual setup

1. Install Node.js 22 or later and pnpm, extract this directory, and run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   pnpm exec wrangler r2 bucket create mfcloud-personal
   pnpm exec wrangler d1 create mfcloud-personal
   ```

2. In `wrangler.jsonc`, set `R2_ACCOUNT_ID` to your Cloudflare Account ID and add
   the returned `database_id` to the `DB` binding. If you choose another bucket
   name, update both `r2_buckets[0].bucket_name` and `R2_BUCKET_NAME` to match.
   Keep R2 public access and `r2.dev` disabled.

3. In Cloudflare → R2 → Manage API Tokens, create an **Object Read & Write** token
   restricted to this bucket. Save the returned values as Worker secrets:

   ```sh
   pnpm exec wrangler secret put R2_ACCESS_KEY_ID
   pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY
   ```

4. Generate a separate connection token with `openssl rand -hex 32`. Store it in
   a password manager, then enter it at the prompt below. Do not reuse an R2 key.

   ```sh
   pnpm exec wrangler secret put OWNER_TOKEN
   pnpm exec wrangler d1 migrations apply DB --remote
   pnpm exec wrangler deploy
   ```

5. Use the HTTPS Worker URL printed after deployment. Optionally add a Worker
   custom domain and set `PUBLIC_ORIGIN` to that exact HTTPS origin. This domain
   belongs to the Worker, not the R2 bucket. Do not change it after issuing links
   unless the original domain will keep routing to this Worker.

6. In R2, add lifecycle fallbacks scoped to `objects/`: abort incomplete multipart
   uploads after one day and expire objects after 32 days. The Worker's five-minute
   Cron handles normal expiry, deletion and retries; keep it enabled.

7. In MFinder → Settings → Quick Share, select your personal R2 connection, enter
   the Worker URL and `OWNER_TOKEN`, and click **Test Connection**. The test creates
   and deletes a private probe. Then share a disposable file and verify its download.

Default quota is 10 GB and maximum file size is 500 MB. Change `QUOTA_BYTES` and
`MAX_FILE_BYTES` in `wrangler.jsonc` if needed, then redeploy. Values are decimal
bytes; the protocol supports a maximum file size of 5 GB. Supported expiry times
are 24 hours, 3 days, 7 days and 30 days.

New shares use six case-sensitive letters and digits (`A–Z`, `a–z`, `0–9`).
Pre-release 22-character links are no longer routed. Their data remains subject
to expiry and authenticated deletion. Codes are
cryptographically random, checked by a database uniqueness constraint and retried
on collision; deleted codes are never reused. Six characters provide about 35.7
bits of entropy, so these links are easier to guess than the previous 128-bit
links. Per-IP throttling reduces guessing from one address but does not prevent
distributed guessing. A link grants access to anyone who obtains it.

The recipient page adapts to phone screens and the system light/dark appearance.
It uses English or Vietnamese from the browser language, presents file types and
UTC expiry clearly, and works without JavaScript or external fonts.
PNG, JPEG, GIF and WebP images display directly on the page and expose Open Graph
image metadata for link previews. Long screenshots scroll within the viewer.
Redeploy the updated Worker to enable this on an existing personal connection;
no database migration is needed for image previews.

MFinder 2.2.173 and later hand out the link while the files are still uploading.
Until the upload finishes, the page says the sender is still uploading, lists the
files that are ready and refreshes every 30 seconds; only finished files can be
downloaded, and a cancelled or expired upload answers 410. Redeploy the updated
Worker to enable this; no database migration is needed. An older Worker keeps
working and gives the link when the upload finishes.

## Maintain your deployment

- Back up the D1 database and keep R2/D1 bindings unchanged when updating code.
- Rotate the R2 token in Cloudflare and replace both Worker secrets before revoking
  the old token. The app does not need an R2 credential update.
- To rotate the connection token, update `OWNER_TOKEN`, then save a new connection
  in MFinder on each Mac. Existing public links retain their assigned expiry.
- To pause new uploads, set `UPLOADS_ENABLED` to `false` and deploy. Keep downloads
  and Cron running so issued links and cleanup continue to work.
- Monitor Worker errors, D1 usage and storage costs in your Cloudflare dashboard.
  Logs deliberately omit credentials, filenames and share-token URLs.
- Links grant access to anyone who has them. There is no password or automatic
  malware scan in this version. Downloads are attachments, never rendered files.

The SDK XML parser alias in `wrangler.jsonc` is required for Cloudflare Workers.
Do not remove it during upgrades. Validate code with `pnpm typecheck`, `pnpm test`
and `pnpm exec wrangler deploy --dry-run` before deployment.

See [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/),
[Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
and [D1 backups](https://developers.cloudflare.com/d1/reference/time-travel/).
