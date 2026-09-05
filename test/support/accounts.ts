import { GET, POST, PATCH, DEL } from "./http";
import { writeArtifact, readArtifact } from "./env";

/**
 * The QA account roster.
 *
 * Every account is provisioned with its FINAL role and never mutated
 * afterwards. That is not tidiness — AccessService caches for 30s and is never
 * invalidated by any /api/admin/users mutation (access.service.ts has an
 * invalidateAll() that nothing calls), so a role changed after creation binds
 * only after the TTL. A freshly created user has no cache entry, so its role
 * binds on the first request. Accounts 7 and the role-edit probe are the only
 * ones deliberately mutated, and they live in 90-cache-staleness.spec.ts.
 */

export const PLATFORM_ADMIN = { email: "superadmin123@gmail.com", password: "12345678" };

export const QA_PASSWORD = "QaPassw0rd!2026";

export type QaAccountSpec = {
  key: string;
  tenantSlug: string;
  appRole: "owner" | "staff";
  /** null = deliberately no role assigned (fail-open branch B). */
  permissions: string[] | null;
  mustChangePassword?: boolean;
  /** Applied after creation; only used by the suspended fixture. */
  statusAction?: "deactivate" | "suspend";
  proves: string;
};

export const ACCOUNT_SPECS: QaAccountSpec[] = [
  { key: "owner-volt", tenantSlug: "volt", appRole: "owner", permissions: [], proves: "owner bypasses capabilities but not entitlements" },
  { key: "full-volt", tenantSlug: "volt", appRole: "staff", permissions: ["*"], proves: "happy-path baseline" },
  { key: "readonly-volt", tenantSlug: "volt", appRole: "staff", permissions: ["inventory.view", "catalog.view"], proves: "capability 403 on writes" },
  { key: "inbound-volt", tenantSlug: "volt", appRole: "staff", permissions: ["inventory.view", "inventory.receive"], proves: "receive 201 / transfer+count 403" },
  { key: "emptyrole-volt", tenantSlug: "volt", appRole: "staff", permissions: [], proves: "fail-open branch A (zero capabilities)" },
  { key: "norole-volt", tenantSlug: "volt", appRole: "staff", permissions: null, proves: "fail-open branch B (roleId null)" },
  { key: "suspended-volt", tenantSlug: "volt", appRole: "staff", permissions: ["*"], statusAction: "suspend", proves: "STAFF_INACTIVE" },
  { key: "full-nord", tenantSlug: "nord", appRole: "staff", permissions: ["*"], proves: "cross-tenant isolation" },
  { key: "susptenant", tenantSlug: "365-gadgets", appRole: "staff", permissions: ["*"], proves: "TENANT_SUSPENDED" },
  { key: "mustchange-volt", tenantSlug: "volt", appRole: "staff", permissions: ["*"], mustChangePassword: true, proves: "mustChangePassword is frontend-only" },
];

export type ProvisionedAccount = {
  key: string;
  email: string;
  password: string;
  tenantSlug: string;
  tenantId: string;
  appRole: string;
  roleId: string | null;
  userId: string;
  permissions: string[] | null;
  proves: string;
  /** Set only when a statusAction succeeded; absent means "active". */
  status?: string;
};

export type Roster = {
  runId: string;
  createdAt: string;
  accounts: Record<string, ProvisionedAccount>;
  roleIds: string[];
  /** Status mutations the API refused — findings, not fatal errors. */
  statusFailures: { key: string; action: string; status: number; body: string }[];
};

const ROSTER_FILE = "qa-roster.json";

export const loadRoster = (): Roster | null => readArtifact<Roster>(ROSTER_FILE);

export function requireRoster(): Roster {
  const r = loadRoster();
  if (!r) throw new Error("No QA roster found — run `npm run qa:provision` first.");
  return r;
}

/** Actor helper: `as(roster, "full-volt")` → an http.ts Actor. */
export function as(roster: Roster, key: string) {
  const a = roster.accounts[key];
  if (!a) throw new Error(`No QA account "${key}" in roster`);
  return { email: a.email, password: a.password };
}

export const admin = { email: PLATFORM_ADMIN.email, password: PLATFORM_ADMIN.password };

/**
 * Creates roles + users for the roster. Idempotent by email: an existing
 * account is reused rather than recreated, so a crashed run can be resumed.
 */
export async function provision(runId: string): Promise<Roster> {
  const tenants = await GET("/api/admin/tenants", { as: admin });
  if (!tenants.ok) throw new Error(`Cannot list tenants: ${tenants.status} ${JSON.stringify(tenants.body)}`);
  const rows: any[] = tenants.body.data ?? tenants.body;
  const bySlug = new Map(rows.map((t: any) => [t.slug, t]));

  const accounts: Record<string, ProvisionedAccount> = {};
  const roleIds: string[] = [];

  for (const spec of ACCOUNT_SPECS) {
    const tenant = bySlug.get(spec.tenantSlug);
    if (!tenant) throw new Error(`Tenant "${spec.tenantSlug}" not found`);

    // "*" means every capability the tenant's entitlements actually offer —
    // asking for capabilities outside the vertical would be rejected.
    let permissions = spec.permissions;
    if (permissions?.includes("*")) {
      const caps = await GET(`/api/${spec.tenantSlug}/capabilities`, { as: admin });
      permissions = (caps.body.data ?? []).map((c: any) => c.key);
    }

    let roleId: string | null = null;
    if (permissions !== null) {
      const role = await POST("/api/admin/roles", {
        as: admin,
        body: {
          tenantId: tenant.id,
          name: `QA-${spec.key}-${runId}`,
          description: `QA fixture role (${spec.proves})`,
          permissions: [...permissions, "menu:*"],
        },
      });
      if (!role.ok) throw new Error(`Role create failed for ${spec.key}: ${role.status} ${JSON.stringify(role.body)}`);
      roleId = role.body.id ?? role.body.data?.id;
      if (!roleId) throw new Error(`Role create for ${spec.key} returned no id: ${JSON.stringify(role.body).slice(0, 300)}`);
      roleIds.push(roleId);
    }

    const email = `qa-${spec.key}-${runId}@qa.invalid`;
    const created = await POST("/api/admin/users", {
      as: admin,
      body: {
        tenantId: tenant.id,
        name: `QA ${spec.key}`,
        email,
        roleId,
        appRole: spec.appRole,
        sendInvite: false,
        password: QA_PASSWORD,
        mustChangePassword: spec.mustChangePassword ?? false,
      },
    });
    if (!created.ok) throw new Error(`User create failed for ${spec.key}: ${created.status} ${JSON.stringify(created.body)}`);
    // POST /api/admin/users answers `{ user, inviteLink, warning }` — the staff
    // row is nested, unlike POST /api/admin/roles which returns the row itself.
    // Reading `.id` off the envelope silently yields undefined, and the next
    // request becomes `/api/admin/users/undefined/status`, which surfaces as an
    // opaque 500 from PgExceptionFilter (22P02) rather than a 404.
    const userId = created.body.user?.id ?? created.body.data?.id ?? created.body.id;
    if (!userId) {
      throw new Error(`User create for ${spec.key} returned no id: ${JSON.stringify(created.body).slice(0, 300)}`);
    }

    accounts[spec.key] = {
      key: spec.key,
      email,
      password: QA_PASSWORD,
      tenantSlug: spec.tenantSlug,
      tenantId: tenant.id,
      appRole: spec.appRole,
      roleId,
      userId,
      permissions,
      proves: spec.proves,
    };
  }

  // Persist BEFORE the status mutations below. Anything already created must be
  // recoverable by teardown even if a later step fails — otherwise a crash
  // strands real accounts in a shared database with nothing pointing at them.
  const roster: Roster = { runId, createdAt: new Date().toISOString(), accounts, roleIds, statusFailures: [] };
  writeArtifact(ROSTER_FILE, roster);

  // Status mutations happen last so the accounts above are usable immediately.
  // A failure here is recorded rather than thrown: it is itself a finding, and
  // aborting would strand the roster mid-build.
  for (const spec of ACCOUNT_SPECS) {
    if (!spec.statusAction) continue;
    const acct = accounts[spec.key];
    const r = await PATCH(`/api/admin/users/${acct.userId}/status`, {
      as: admin,
      body: { action: spec.statusAction, reason: `QA fixture ${runId}` },
    });
    if (r.ok) {
      acct.status = spec.statusAction === "suspend" ? "suspended" : "deactivated";
    } else {
      roster.statusFailures.push({
        key: spec.key,
        action: spec.statusAction,
        status: r.status,
        body: JSON.stringify(r.body).slice(0, 300),
      });
    }
  }

  writeArtifact(ROSTER_FILE, roster);
  return roster;
}

/** Removes every QA account and role. Never throws — reports instead. */
export async function deprovision(roster: Roster) {
  const report: { kind: string; id: string; outcome: string; detail?: string }[] = [];

  for (const acct of Object.values(roster.accounts)) {
    const r = await DEL(`/api/admin/users/${acct.userId}?hard=true`, { as: admin });
    report.push({
      kind: "user",
      id: acct.email,
      outcome: r.ok || r.status === 404 ? "deleted" : "blocked",
      detail: r.ok || r.status === 404 ? undefined : `${r.status} ${r.message ?? ""}`,
    });
  }
  for (const roleId of roster.roleIds) {
    const r = await DEL(`/api/admin/roles/${roleId}`, { as: admin });
    report.push({
      kind: "role",
      id: roleId,
      outcome: r.ok || r.status === 404 ? "deleted" : "blocked",
      detail: r.ok || r.status === 404 ? undefined : `${r.status} ${r.message ?? ""}`,
    });
  }
  return report;
}
