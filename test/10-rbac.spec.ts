import { beforeAll, describe, expect, it } from "vitest";
import { GET, POST } from "./support/http";
import { as, requireRoster, type Roster } from "./support/accounts";
import { requireFixture, type TenantFixture } from "./support/fixtures";
import { clearedDefect, knownDefect } from "./support/known-defect";
import { currentRunId } from "./support/runid";
import { tokenFor, decodeClaims } from "./support/token";

/**
 * The authorization matrix, exercised against a running server.
 *
 * Four independent gates decide a tenant-scoped request, and they are asserted
 * separately here because in production they fail in a fixed order and a test
 * that conflates them cannot tell you which one actually held:
 *
 *   AuthGuard        no/!bad token                 -> 401
 *   TenantGuard      wrong tenant / tenant status  -> 403 (TENANT_SUSPENDED)
 *   AccessGuard      staff status                  -> 403 (STAFF_INACTIVE)
 *   EntitlementGuard module not sold to the tenant  -> 403 (plain message)
 *   CapabilityGuard  role lacks the capability      -> 403 (CAPABILITY_REQUIRED)
 *
 * The distinction that matters most: an ENTITLEMENT is what the workspace
 * bought, a CAPABILITY is what the person may do. An owner bypasses the second
 * and never the first, which is the single assertion that keeps a role editor
 * from being able to sell modules.
 */

let roster: Roster;
let volt: TenantFixture;
let runId: string;

beforeAll(() => {
  roster = requireRoster();
  volt = requireFixture("volt");
  runId = currentRunId();
});

/** A module volt has NOT bought — the entitlement probe. */
const UNSOLD = "customers";

const draftReceipt = (warehouseId: string, skuId: string) => ({
  warehouseId,
  supplierName: `QA Supplier ${runId}`,
  items: [{ skuId, qty: 5 }],
});

describe("unauthenticated", () => {
  it("rejects a request with no token", async () => {
    const r = await GET("/api/volt/warehouses");
    expect(r.status).toBe(401);
  });

  it("rejects a structurally valid but unsigned token", async () => {
    const r = await GET("/api/volt/warehouses", { as: { token: "not.a.jwt" } });
    expect(r.status).toBe(401);
  });
});

describe("capability enforcement (readonly-volt: inventory.view + catalog.view)", () => {
  it("allows the reads its role grants", async () => {
    const wh = await GET("/api/volt/warehouses?pageSize=1", { as: as(roster, "readonly-volt") });
    expect(wh.status).toBe(200);

    const products = await GET("/api/volt/products?pageSize=1", { as: as(roster, "readonly-volt") });
    expect(products.status).toBe(200);
  });

  it("refuses a warehouse write with CAPABILITY_REQUIRED naming the missing key", async () => {
    const r = await POST("/api/volt/warehouses", {
      as: as(roster, "readonly-volt"),
      body: { name: `QA-DENIED-${runId}`, type: "central", status: "active" },
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("CAPABILITY_REQUIRED");
    // The key must be named. A bare "forbidden" leaves an admin no way to know
    // which box to tick in the role editor.
    expect(r.body.required).toContain("warehouses.manage");
  });

  it("refuses a product write even though it may read products", async () => {
    const r = await POST("/api/volt/products", {
      as: as(roster, "readonly-volt"),
      body: { nameEn: `QA-DENIED-${runId}`, slug: `qa-denied-${runId}`, status: "active", price: 1 },
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("CAPABILITY_REQUIRED");
    expect(r.body.required).toContain("catalog.manage");
  });
});

describe("capability enforcement (inbound-volt: inventory.view + inventory.receive)", () => {
  it("may draft an inbound receipt", async () => {
    const r = await POST("/api/volt/inbound-receipts/new", {
      as: as(roster, "inbound-volt"),
      body: draftReceipt(volt.warehouseA.id, volt.sku.id),
    });
    expect(r.status).toBe(201);
    expect(r.body.receipt.ref).toMatch(/^GRN-/);
    // Drafting must not move stock — that is what confirm is for.
    expect(r.body.receipt.status).toBe("draft");
  });

  it("may not open a transfer (inventory.transfer)", async () => {
    const r = await POST("/api/volt/stock-transfers/new", {
      as: as(roster, "inbound-volt"),
      body: {
        fromWarehouseId: volt.warehouseA.id,
        toWarehouseId: volt.warehouseB.id,
        items: [{ skuId: volt.sku.id, qty: 1 }],
      },
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("CAPABILITY_REQUIRED");
    expect(r.body.required).toContain("inventory.transfer");
  });

  it("may not open a stock count (inventory.count)", async () => {
    const r = await POST("/api/volt/cycle-counts/new", {
      as: as(roster, "inbound-volt"),
      body: { warehouseId: volt.warehouseA.id, scope: "manual", skuIds: [volt.sku.id] },
    });
    expect(r.status).toBe(403);
    expect(r.code).toBe("CAPABILITY_REQUIRED");
    expect(r.body.required).toContain("inventory.count");
  });
});

describe("owner bypass", () => {
  it("writes without holding a single capability key", async () => {
    // owner-volt's role carries no capabilities at all; `bypass` is what lets
    // this through, so a 403 here would mean the app-role bypass is broken.
    const r = await POST("/api/volt/warehouses", {
      as: as(roster, "owner-volt"),
      body: { name: `QA-WH-OWNER-${runId}`, type: "regional", status: "active" },
    });
    expect(r.status).toBe(201);
  });

  it("is still refused a module the workspace never bought", async () => {
    // The load-bearing assertion of the whole file: capability bypass must not
    // leak into entitlements, or an owner could use modules nobody sold them.
    const r = await GET(`/api/volt/${UNSOLD}?pageSize=1`, { as: as(roster, "owner-volt") });
    expect(r.status).toBe(403);
    expect(r.code).not.toBe("CAPABILITY_REQUIRED");
    expect(String(r.body.message)).toMatch(/is not enabled for this tenant/);
  });
});

describe("tenant isolation", () => {
  it("refuses a nord staff member reading volt", async () => {
    const r = await GET("/api/volt/warehouses?pageSize=1", { as: as(roster, "full-nord") });
    expect(r.status).toBe(403);
    // Deliberately NOT a TENANT_SUSPENDED-style coded error: this is the
    // "wrong workspace" branch of TenantGuard, which answers a plain message.
    expect(String(r.body.message)).toMatch(/do not have access to this tenant/i);
  });

  it("lets the same account read its own tenant", async () => {
    const r = await GET("/api/nord/warehouses?pageSize=1", { as: as(roster, "full-nord") });
    expect(r.status).toBe(200);
  });
});

describe("lifecycle gates", () => {
  it("closes a suspended workspace to its own member with TENANT_SUSPENDED", async () => {
    const r = await GET("/api/365-gadgets/products?pageSize=1", { as: as(roster, "susptenant") });
    expect(r.status).toBe(403);
    expect(r.code).toBe("TENANT_SUSPENDED");
    expect(r.body.status).toBe("suspended");
  });

  it("still lets a platform admin into a suspended workspace (repair access)", async () => {
    const { admin } = await import("./support/accounts");
    const r = await GET("/api/365-gadgets/products?pageSize=1", { as: admin });
    expect(r.status).toBe(200);
  });

  it("a suspended staff member cannot obtain a token at all", async () => {
    // PlatformUsersService.setStatus bans the GoTrue identity as well as
    // flipping staff_users.status, so suspension bites at the auth server
    // before AccessGuard ever runs. That is defence in depth and worth pinning:
    // if the ban were dropped, this test starts passing a token through and the
    // 30s AccessService window (see 90-cache-staleness) becomes the only guard.
    const acct = roster.accounts["suspended-volt"];
    expect(acct.status).toBe("suspended");

    await expect(tokenFor(acct.email, acct.password)).rejects.toThrow(/grant failed/i);

    clearedDefect(
      {
        id: "QA-AUTH-01",
        title: "Suspending a staff user revokes their credentials at the auth server",
        severity: "high",
        expected: "A suspended user cannot authenticate, and cannot use an existing session.",
        source: "platform-users.service.ts setStatus -> supabase.updateUserById(ban_duration)",
      },
      "Password grant for a suspended account is rejected by GoTrue; the API layer is never reached.",
    );
  });
});

describe("fail-open branches (CapabilityGuard.unconfigured)", () => {
  /**
   * Both branches below are documented as deliberate — a deploy landing before
   * scripts/backfill-rbac.ts must degrade rather than lock a workspace out. The
   * finding is not that the code is surprising; it is that the escape hatch is
   * still REACHABLE through the supported admin API today, long after the
   * backfill ran. Nothing in POST /api/admin/users or /api/admin/roles stops an
   * admin from producing either shape, and both grant full write access.
   */

  knownDefect(
    {
      id: "QA-RBAC-01",
      title: "A role with zero capability keys grants full write access (fail-open branch A)",
      severity: "high",
      expected:
        "A staff user whose role grants no capabilities should be able to do nothing that requires one (403 CAPABILITY_REQUIRED).",
      source: "capability.guard.ts unconfigured() — access.capabilities.length === 0",
    },
    async () => {
      const r = await POST("/api/volt/warehouses", {
        as: as(roster, "emptyrole-volt"),
        body: { name: `QA-WH-EMPTYROLE-${runId}`, type: "regional", status: "active" },
      });
      expect(r.status).toBe(201); // pins TODAY's behaviour, not the desired one
      return `Staff user with a role carrying 0 capability keys created a warehouse: ${r.status} ${r.body.id}`;
    },
  );

  knownDefect(
    {
      id: "QA-RBAC-02",
      title: "A staff user with no role at all grants full write access (fail-open branch B)",
      severity: "high",
      expected: "A staff user with role_id NULL should be able to do nothing that requires a capability.",
      source: "capability.guard.ts unconfigured() — access.roleId === null",
    },
    async () => {
      const r = await POST("/api/volt/warehouses", {
        as: as(roster, "norole-volt"),
        body: { name: `QA-WH-NOROLE-${runId}`, type: "regional", status: "active" },
      });
      expect(r.status).toBe(201);
      return `Staff user with role_id NULL created a warehouse: ${r.status} ${r.body.id}`;
    },
  );
});

describe("mustChangePassword", () => {
  knownDefect(
    {
      id: "QA-AUTH-02",
      title: "mustChangePassword is advisory only — the API does not enforce it",
      severity: "medium",
      expected:
        "A user flagged must_change_password should be limited to the password-change endpoints until they replace it.",
      source: "platform-users.service.ts appMetadata.must_change_password; no guard reads the claim",
    },
    async () => {
      const acct = roster.accounts["mustchange-volt"];
      const token = await tokenFor(acct.email, acct.password);
      const claims = decodeClaims(token);
      const meta = (claims.app_metadata ?? {}) as Record<string, unknown>;
      expect(meta.must_change_password).toBe(true);

      // The flag is set, and the API serves the request anyway.
      const r = await GET("/api/volt/warehouses?pageSize=1", { as: { token } });
      expect(r.status).toBe(200);

      return `Token carries app_metadata.must_change_password=true, yet GET /api/volt/warehouses answered ${r.status}. Enforcement is frontend-only.`;
    },
  );
});

describe("input handling on admin routes", () => {
  knownDefect(
    {
      id: "QA-PLAT-01",
      title: "A non-UUID :id on an admin user route answers 500 instead of 404",
      severity: "medium",
      expected: "An unparseable id is a client error — 400 or 404, not an Internal Server Error.",
      source: "platform-users.service.ts load() passes :id straight to a uuid column; PgExceptionFilter maps 22P02 to 500",
    },
    async () => {
      const { admin } = await import("./support/accounts");
      const r = await GET("/api/admin/users/not-a-uuid", { as: admin });
      expect(r.status).toBe(500);
      expect(String(r.body.message)).toMatch(/database query failed/i);
      return `GET /api/admin/users/not-a-uuid -> ${r.status} "${r.body.message}" (Postgres 22P02 invalid_text_representation leaked as a 500)`;
    },
  );
});
