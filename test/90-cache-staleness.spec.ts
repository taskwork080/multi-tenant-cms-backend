import { afterAll, beforeAll, describe, expect } from "vitest";
import { GET, POST, PATCH, DEL, until, type Actor } from "./support/http";
import { QA_PASSWORD, admin, requireRoster } from "./support/accounts";
import { knownDefect } from "./support/known-defect";
import { currentRunId } from "./support/runid";
import { tokenFor } from "./support/token";

/**
 * How long an authorization change takes to actually bind.
 *
 * AccessService caches resolved access for 30s per process and exposes
 * `invalidate(authUserId)` / `invalidateAll()` for the writer to close that
 * window. Its own comment says the window is "acceptable for administrative
 * changes; `invalidate` covers the process that made the change" — so the
 * documented contract is that a change made through the API binds IMMEDIATELY
 * on the process that served it, and only other instances lag.
 *
 * That contract is not kept. Only profile.controller.ts and
 * staff-invite.controller.ts call `invalidate`; nothing calls `invalidateAll`.
 * PlatformUsersService.setStatus and PlatformRolesService.update — the two
 * endpoints an admin actually uses to revoke access — do not, so revocation
 * lags on the very process that performed it.
 *
 * These tests measure the lag rather than asserting a number, and pin it as a
 * known defect. Each one runs its OWN throwaway account: an account whose role
 * is mutated mid-run cannot be shared with the matrix in 10-rbac.spec.ts
 * without making that file's results depend on the order they ran in.
 *
 * Not covered here: tenant status. TenantService has the same 30s window, but
 * platform-tenants.controller.ts DOES call `tenantSvc.invalidate` on update, so
 * the analogous test would need to suspend a real workspace on a shared live
 * database. Reading the call site is cheaper than that risk.
 */

const SLUG = "volt";
let runId: string;
let tenantId: string;
const trash: { users: string[]; roles: string[] } = { users: [], roles: [] };

beforeAll(async () => {
  runId = currentRunId();
  requireRoster();
  const tenants = await GET("/api/admin/tenants", { as: admin });
  const volt = (tenants.body.data ?? tenants.body).find((t: any) => t.slug === SLUG);
  if (!volt) throw new Error(`Tenant ${SLUG} not found`);
  tenantId = volt.id;
});

afterAll(async () => {
  // These probes are created inside the spec rather than by qa-provision, so
  // they are this file's responsibility. They also match the qa-*@qa.invalid
  // pattern, so `npm run qa:sweep` is the backstop if this hook never runs.
  for (const id of trash.users) await DEL(`/api/admin/users/${id}?hard=true`, { as: admin });
  for (const id of trash.roles) await DEL(`/api/admin/roles/${id}`, { as: admin });
});

/** Creates a throwaway role + user and returns an actor bound to it. */
async function probe(name: string, permissions: string[]): Promise<{ actor: Actor; userId: string; roleId: string }> {
  const role = await POST("/api/admin/roles", {
    as: admin,
    body: {
      tenantId,
      name: `QA-${name}-${runId}`,
      description: `QA staleness probe (${name})`,
      permissions: [...permissions, "menu:*"],
    },
  });
  if (!role.ok) throw new Error(`probe role failed: ${role.status} ${JSON.stringify(role.body)}`);
  const roleId = role.body.id;
  trash.roles.push(roleId);

  const email = `qa-${name}-${runId}@qa.invalid`;
  const user = await POST("/api/admin/users", {
    as: admin,
    body: {
      tenantId,
      name: `QA ${name}`,
      email,
      roleId,
      appRole: "staff",
      sendInvite: false,
      password: QA_PASSWORD,
      mustChangePassword: false,
    },
  });
  if (!user.ok) throw new Error(`probe user failed: ${user.status} ${JSON.stringify(user.body)}`);
  const userId = user.body.user.id;
  trash.users.push(userId);

  // Bind the token to `token` rather than `{email,password}` so that later
  // requests never trigger a fresh password grant — a suspended account cannot
  // obtain one, and this file needs to keep using the session it already has.
  return { actor: { token: await tokenFor(email, QA_PASSWORD) }, userId, roleId };
}

describe("revoking a capability", () => {
  knownDefect(
    {
      id: "QA-CACHE-01",
      title: "Editing a role's permissions does not invalidate AccessService — revocation lags up to 30s",
      severity: "high",
      expected:
        "PATCH /api/admin/roles/:id should call AccessService.invalidateAll(), so the revocation binds on the next request.",
      source: "platform-roles.controller.ts update() — no invalidate call; access.service.ts invalidateAll() has no callers",
    },
    async () => {
      const { actor, roleId } = await probe("stale-role", ["inventory.view", "warehouses.manage"]);

      // Prime the cache with a request that USES the capability, immediately
      // before revoking it — so the 30s clock starts as late as possible and
      // the staleness below cannot be an artefact of a slow setup.
      const before = await POST(`/api/${SLUG}/warehouses`, {
        as: actor,
        body: { name: `QA-WH-STALE-A-${runId}`, type: "regional", status: "active" },
      });
      expect(before.status).toBe(201);

      const revoked = await PATCH(`/api/admin/roles/${roleId}`, {
        as: admin,
        body: { permissions: ["inventory.view", "menu:*"] },
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.permissions).not.toContain("warehouses.manage");

      // The revocation is committed. The API still honours the old role.
      const after = await POST(`/api/${SLUG}/warehouses`, {
        as: actor,
        body: { name: `QA-WH-STALE-B-${runId}`, type: "regional", status: "active" },
      });
      expect(after.status).toBe(201); // pins TODAY's behaviour

      const lag = await until(
        async () => {
          const r = await POST(`/api/${SLUG}/warehouses`, {
            as: actor,
            body: { name: `QA-WH-STALE-P-${runId}-${Date.now()}`, type: "regional", status: "active" },
          });
          return r.status === 403 && r.code === "CAPABILITY_REQUIRED";
        },
        { timeout: 45_000, interval: 2_000, label: "revoked capability to bind" },
      );

      expect(lag).toBeGreaterThan(0);
      return `Capability revoked at T+0; writes kept succeeding and the 403 first appeared ~${Math.round(lag / 1000)}s later (AccessService TTL is 30s).`;
    },
    120_000,
  );
});

describe("suspending a staff member", () => {
  knownDefect(
    {
      id: "QA-CACHE-02",
      title: "Suspending a staff user does not invalidate AccessService — an open session survives up to 30s",
      severity: "high",
      expected:
        "PATCH /api/admin/users/:id/status should call AccessService.invalidate(authUserId), so suspension bites on the next request.",
      source: "platform-users.service.ts setStatus() — bans in GoTrue but never invalidates the resolved-access cache",
    },
    async () => {
      const { actor, userId } = await probe("stale-suspend", ["inventory.view"]);

      const before = await GET(`/api/${SLUG}/warehouses?pageSize=1`, { as: actor });
      expect(before.status).toBe(200);

      const suspended = await PATCH(`/api/admin/users/${userId}/status`, {
        as: admin,
        body: { action: "suspend", reason: `QA staleness probe ${runId}` },
      });
      expect(suspended.status).toBe(200);
      expect(suspended.body.status).toBe("suspended");

      // The GoTrue ban stops NEW logins, but the token already issued is a
      // self-contained JWT that AuthGuard verifies by signature. So the only
      // thing standing between a suspended user and the API is AccessGuard —
      // reading a cache that nobody invalidated.
      const after = await GET(`/api/${SLUG}/warehouses?pageSize=1`, { as: actor });
      expect(after.status).toBe(200); // pins TODAY's behaviour

      const lag = await until(
        async () => {
          const r = await GET(`/api/${SLUG}/warehouses?pageSize=1`, { as: actor });
          return r.status === 403 && r.code === "STAFF_INACTIVE";
        },
        { timeout: 45_000, interval: 2_000, label: "suspension to bind" },
      );

      expect(lag).toBeGreaterThan(0);
      return `Suspended at T+0; the existing session kept reading and STAFF_INACTIVE first appeared ~${Math.round(lag / 1000)}s later.`;
    },
    120_000,
  );
});
