import "./lib/env-target";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

/**
 * End-to-end check of the R2 configuration, for the deploy step that turns
 * uploads on.
 *
 * With the credentials missing, every upload answers 503 from R2Service.ensure()
 * and that is the whole story. Once they are filled in there are four further
 * ways for it to be wrong, and three of them are silent:
 *
 *   - token not scoped to this bucket      -> 403 on the first real upload
 *   - R2_BUCKET naming a bucket that isn't -> 404, looks identical to the above
 *   - public access never enabled          -> uploads succeed, images 404 later
 *   - R2_PUBLIC_URL blank                  -> images work for 7 days, then 403
 *
 * So this walks the same path R2Service does — same client, same key shape,
 * same presigned PUT — and then fetches the object back through the PUBLIC base
 * rather than through a signed URL, because only that proves an uploaded asset
 * is actually readable by a browser.
 *
 *   npx tsx scripts/verify-r2.ts --env=prod --allow-prod
 *
 * It writes one small object under `__verify__/` and deletes it again.
 *
 * WHAT IT CANNOT CHECK: CORS. The bucket's CORS policy is enforced by the
 * browser against the Origin header, not by the S3 API, so every request here
 * passes whether or not the policy exists. A green run still leaves the browser
 * upload untested — see docs/RENDER.md section 6.
 */

const VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"] as const;

let failures = 0;

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function bad(msg: string) {
  console.log(`  ✖ ${msg}`);
  failures += 1;
}
function warn(msg: string) {
  console.log(`  ⚠ ${msg}`);
}
function heading(title: string) {
  console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`);
}

/** Shape, never the value — same principle as env-target's describeDb(). */
function describe(name: string, value: string | undefined): string {
  if (!value) return `${name}: NOT SET`;
  if (name === "R2_PUBLIC_URL" || name === "R2_BUCKET") return `${name}: ${value}`;
  return `${name}: set (${value.length} chars)`;
}

async function main() {
  heading("1. Configuration");
  const env = Object.fromEntries(VARS.map((v) => [v, process.env[v]])) as Record<(typeof VARS)[number], string | undefined>;
  for (const v of VARS) console.log(`  ${describe(v, env[v])}`);

  const trio = [env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY];
  const set = trio.filter(Boolean).length;
  if (set === 0) {
    console.log("\n  R2 is not configured — every upload will answer 503. Nothing further to check.");
    process.exit(1);
  }
  if (set < 3) {
    bad(`only ${set} of the 3 credentials are set — the API refuses to boot on a partial trio`);
    process.exit(1);
  }

  // Mirrors R2Service's own defaulting (r2.service.ts:27-28).
  const bucket = env.R2_BUCKET ?? "cms-assets";
  const publicBase = (env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!publicBase) {
    warn("R2_PUBLIC_URL is blank. R2Service then returns a 7-DAY PRESIGNED GET as the");
    warn("asset's permanent URL, and the frontend stores that string on the row. Every");
    warn("image would load for a week and then 403, with dead URLs already in the database.");
    failures += 1;
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
  });

  heading(`2. Credentials and bucket "${bucket}"`);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    ok("HeadBucket succeeded — credentials valid and the bucket is reachable");
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode;
    bad(`HeadBucket failed (${e.name ?? "?"}, HTTP ${status ?? "?"})`);
    if (status === 403) console.log("      403 = the API token is not scoped to this bucket.");
    if (status === 404) console.log(`      404 = no bucket named "${bucket}" in this account.`);
    if (status === 401) console.log("      401 = the access key or secret is wrong.");
    process.exit(1);
  }

  // Same key shape as R2Service.presignUpload, under a prefix no tenant can
  // claim (slugs cannot contain underscores).
  const key = `__verify__/${randomUUID()}.txt`;
  const body = `r2 verification ${new Date().toISOString()}`;

  heading("3. Presigned upload (the path the browser takes)");
  let uploaded = false;
  try {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "text/plain" }),
      { expiresIn: 600 },
    );
    const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body });
    if (res.ok) {
      uploaded = true;
      ok(`PUT ${key} -> ${res.status}`);
    } else {
      bad(`PUT returned ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    bad(`presigned PUT failed: ${(err as Error).message}`);
  }

  heading("4. Public read-back (does R2_PUBLIC_URL actually serve the object?)");
  if (!publicBase) {
    warn("skipped — R2_PUBLIC_URL is blank (see the warning above)");
  } else if (!uploaded) {
    warn("skipped — nothing was uploaded to read back");
  } else {
    const publicUrl = `${publicBase}/${key}`;
    try {
      const res = await fetch(publicUrl);
      if (res.ok && (await res.text()) === body) {
        ok(`GET ${publicBase}/… -> 200, contents match`);
      } else if (res.status === 401 || res.status === 403 || res.status === 404) {
        bad(`GET returned ${res.status} — public access is almost certainly not enabled on the bucket`);
        console.log("      Cloudflare → R2 → bucket → Settings → Public access → R2.dev subdomain → Allow.");
        console.log("      Uploads will appear to work and every image will be broken.");
      } else {
        bad(`GET returned ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      bad(`public GET failed: ${(err as Error).message}`);
    }
  }

  heading("5. Cleanup");
  if (uploaded) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      ok(`deleted ${key}`);
    } catch (err) {
      warn(`could not delete ${key}: ${(err as Error).message} — remove it by hand`);
    }
  } else {
    ok("nothing to clean up");
  }

  // Signed reads are what presignDownload serves, and what publicUrl falls back
  // to when R2_PUBLIC_URL is blank; checked last because it is the least
  // load-bearing once a public base is configured.
  heading("6. Signed read (presign-download path)");
  try {
    await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 });
    ok("signing works");
  } catch (err) {
    bad(`could not sign a GET: ${(err as Error).message}`);
  }

  heading(failures ? `${failures} problem(s) found` : "All checks passed");
  console.log("  CORS is NOT covered by this script — it is a browser-side check. Upload an");
  console.log("  image from the admin app and watch for a CORS error in devtools.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
