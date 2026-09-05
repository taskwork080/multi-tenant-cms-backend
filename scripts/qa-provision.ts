/**
 * Stands up the QA run: snapshot -> accounts -> fixtures.
 *
 * Run before the QA specs (`npm run qa:provision`). Kept out of a Vitest
 * globalSetup on purpose — provisioning touches a shared live database, so it
 * should be an explicit, resumable, separately-inspectable step rather than
 * something that fires implicitly whenever anyone runs `npm test`.
 */
import { newRunId } from "../test/support/runid";
import { provision, admin } from "../test/support/accounts";
import { buildFixture } from "../test/support/fixtures";
import { snapshotAll } from "../test/support/snapshot";
import { GET } from "../test/support/http";
import { ENV, writeArtifact } from "../test/support/env";

const TENANTS = ["volt", "nord"];

async function main() {
  console.log(`[qa] API      : ${ENV.apiUrl}`);
  console.log(`[qa] Supabase : ${ENV.supabaseUrl}`);

  const health = await GET("/health");
  if (!health.ok || health.body?.database !== "ok") {
    throw new Error(`Backend not healthy: ${health.status} ${JSON.stringify(health.body)}`);
  }
  console.log(`[qa] health   : ${JSON.stringify(health.body)}`);

  const me = await GET("/api/me", { as: admin });
  if (!me.ok || me.body?.user?.role !== "platform_admin") {
    throw new Error(`Platform admin credential rejected: ${me.status} ${JSON.stringify(me.body)}`);
  }
  console.log(`[qa] admin    : ${me.body.user.email} (${me.body.user.role})`);

  const runId = newRunId();
  console.log(`[qa] runId    : ${runId}`);

  console.log("[qa] snapshotting tenants (pre-run baseline)...");
  const before = await snapshotAll(TENANTS, "before");
  for (const t of TENANTS) {
    console.log(`  ${t}: ${before[t].warehouses.length} warehouses, counts=${JSON.stringify(before[t].counts)}`);
  }

  console.log("[qa] provisioning roles + accounts...");
  const roster = await provision(runId);
  console.log(`  ${Object.keys(roster.accounts).length} accounts, ${roster.roleIds.length} roles`);

  console.log("[qa] building tenant fixtures...");
  for (const slug of TENANTS) {
    const f = await buildFixture(admin, slug, runId);
    console.log(`  ${slug}: ${f.warehouseA.name} + ${f.warehouseB.name}, sku ${f.sku.code}`);
  }

  writeArtifact("provision-ok.json", { runId, tenants: TENANTS, at: new Date().toISOString() });
  console.log(`\n[qa] ready. runId=${runId}`);
}

main().catch((err) => {
  console.error("[qa] provision failed:", err.message);
  process.exit(1);
});
