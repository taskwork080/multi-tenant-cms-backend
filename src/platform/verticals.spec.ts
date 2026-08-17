import { describe, expect, it } from "vitest";
import { CAPABILITIES, capabilitiesFor, intersectWithEntitlements } from "../auth/capabilities";
import { RESOURCES } from "../crud/resource-registry";
import {
  MODULE_KEYS,
  MODULE_PRESETS,
  TENANT_TYPES,
  TYPE_ALLOWED_MODULES,
  TYPE_CONFIG_FIELDS,
  configFieldsOutsideType,
  modulesOutsideType,
  presetFor,
} from "./module-presets";
import { ROLE_TEMPLATES, permissionsFor, templatesFor } from "./role-templates";

/**
 * The regression net for the whole vertical story.
 *
 * These are the invariants that were silently false before: a warehouse
 * workspace could hold `cms`, a capability could name a module that does not
 * exist, a role template could grant a key its own vertical can never use.
 * All of them are pure functions over the registries, so this suite is fast
 * enough to gate every commit and needs no database.
 */
describe("module presets and ceilings", () => {
  it("every preset stays inside its own vertical's ceiling", () => {
    for (const type of TENANT_TYPES) {
      expect(modulesOutsideType(type, MODULE_PRESETS[type])).toEqual([]);
    }
  });

  it("a warehouse workspace can never be given the storefront or marketing surface", () => {
    const forbidden = ["cms", "storefront", "sales", "discounts", "reviews", "customers", "tax", "badges"];
    expect(modulesOutsideType("warehouse", forbidden).sort()).toEqual([...forbidden].sort());
  });

  it("commerce verticals may hold every module", () => {
    for (const type of ["ecommerce", "marketplace"] as const) {
      expect(modulesOutsideType(type, MODULE_KEYS)).toEqual([]);
    }
  });

  it("every ceiling references only real module keys", () => {
    const known = new Set<string>(MODULE_KEYS);
    for (const type of TENANT_TYPES) {
      for (const m of TYPE_ALLOWED_MODULES[type]) expect(known.has(m)).toBe(true);
    }
  });

  it("an unknown tenant type falls back to the ecommerce preset rather than an empty sidebar", () => {
    expect(presetFor("nonsense")).toEqual(presetFor("ecommerce"));
  });
});

describe("capability catalog", () => {
  it("every capability names a real module", () => {
    const known = new Set<string>(MODULE_KEYS);
    for (const c of CAPABILITIES) expect(known.has(c.module)).toBe(true);
  });

  it("capability keys never collide with the menu: namespace they share a column with", () => {
    for (const c of CAPABILITIES) {
      expect(c.key).not.toContain(":");
      expect(c.key).toContain(".");
    }
  });

  it("a warehouse workspace is offered inventory keys and no marketing ones", () => {
    const offered = capabilitiesFor(MODULE_PRESETS.warehouse).map((c) => c.key);
    expect(offered).toContain("inventory.receive");
    expect(offered).toContain("packing.manage");
    expect(offered).not.toContain("marketing.manage");
    expect(offered).not.toContain("storefront.manage");
  });

  it("an ecommerce workspace is offered the storefront and not the inventory sub-modules", () => {
    const offered = capabilitiesFor(MODULE_PRESETS.ecommerce).map((c) => c.key);
    expect(offered).toContain("storefront.manage");
    expect(offered).toContain("orders.manage");
    // ECOMMERCE has `inventory` but not inventoryInbound/Counts.
    expect(offered).toContain("inventory.view");
    expect(offered).not.toContain("inventory.receive");
    expect(offered).not.toContain("inventory.count");
  });

  it("intersectWithEntitlements drops keys whose module is locked", () => {
    expect(intersectWithEntitlements(["catalog.view", "marketing.manage"], ["products"])).toEqual(["catalog.view"]);
  });
});

describe("role templates", () => {
  it("every vertical seeds at least a manager and a viewer", () => {
    for (const type of TENANT_TYPES) {
      const names = templatesFor(type).map((t) => t.name);
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(names).toContain("Viewer");
    }
  });

  it("every templated capability is a real key", () => {
    const known = new Set<string>(CAPABILITIES.map((c) => c.key));
    for (const type of TENANT_TYPES) {
      for (const t of ROLE_TEMPLATES[type]) {
        for (const c of t.capabilities) expect(known.has(c)).toBe(true);
      }
    }
  });

  it("a template never grants a capability its own vertical cannot hold", () => {
    for (const type of TENANT_TYPES) {
      const entitlements = MODULE_PRESETS[type];
      for (const t of ROLE_TEMPLATES[type]) {
        const granted = permissionsFor(t, entitlements).filter((p) => !p.startsWith("menu:"));
        expect(intersectWithEntitlements(granted, entitlements)).toEqual(granted);
      }
    }
  });

  it("the warehouse vertical can express the roles it could not before", () => {
    const names = templatesFor("warehouse").map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Inbound Clerk", "Picker / Packer", "Stock Controller"]));

    const clerk = templatesFor("warehouse").find((t) => t.name === "Inbound Clerk")!;
    expect(clerk.capabilities).toContain("inventory.receive");
    // A receiving clerk must not be able to post a count — that is the
    // separation of duties the old catalog could not express at all.
    expect(clerk.capabilities).not.toContain("inventory.count");
    expect(clerk.capabilities).not.toContain("inventory.adjust");
  });

  it("the warehouse roles that meet unknown goods can put them on file", () => {
    // In a warehouse an item IS an inventory record, so the item master is part
    // of the receiving and stock-accuracy jobs — not a separate catalog role.
    // Without this, an Inbound Clerk facing a pallet of something unlisted had
    // no move at all: `skus/generate` needs inventory.adjust, which they lack.
    for (const name of ["Inbound Clerk", "Stock Controller"]) {
      const role = templatesFor("warehouse").find((t) => t.name === name)!;
      expect(role.capabilities, name).toContain("catalog.manage");
      expect(role.menu, name).toContain("menu:/products/new");
    }
  });

  it("picking and packing stays read-only on the item master", () => {
    const picker = templatesFor("warehouse").find((t) => t.name === "Picker / Packer")!;
    expect(picker.capabilities).toContain("catalog.view");
    expect(picker.capabilities).not.toContain("catalog.manage");
  });

  it("no commerce role is handed the item master by accident", () => {
    // catalog.manage in a shop also means storefront copy and pricing, so it
    // belongs to the Catalog Editor and the manager, nobody else.
    for (const type of ["ecommerce", "marketplace"] as const) {
      const holders = templatesFor(type)
        .filter((t) => t.capabilities.includes("catalog.manage"))
        .map((t) => t.name);
      expect(holders.sort()).toEqual(["Catalog Editor", type === "ecommerce" ? "Store Manager" : "Marketplace Manager"].sort());
    }
  });

  it("every template writes at least one menu key, so no role reads as unconfigured", () => {
    for (const type of TENANT_TYPES) {
      for (const t of ROLE_TEMPLATES[type]) expect(t.menu.length).toBeGreaterThan(0);
    }
  });
});

describe("resource registry", () => {
  it("every resource capability is a real key", () => {
    const known = new Set<string>(CAPABILITIES.map((c) => c.key));
    for (const [slug, def] of Object.entries(RESOURCES)) {
      if (!def.capabilities) continue;
      if (def.capabilities.read) expect(known.has(def.capabilities.read), `${slug}.read`).toBe(true);
      expect(known.has(def.capabilities.write), `${slug}.write`).toBe(true);
    }
  });

  it("every resource module is a real module key", () => {
    const known = new Set<string>(MODULE_KEYS);
    for (const [slug, def] of Object.entries(RESOURCES)) {
      if (def.module) expect(known.has(def.module), slug).toBe(true);
    }
  });

  /**
   * Shared surfaces every member of a workspace uses: their own notes, the
   * team calendar, the message threads. Gating these behind a capability would
   * mean a picker cannot leave a note about a damaged pallet.
   *
   * Listed explicitly, so a NEW ungated resource fails the test below rather
   * than quietly joining them.
   */
  const OPEN_TO_ALL_MEMBERS = new Set(["conversations", "schedule-events", "notes"]);

  it("every write is either gated by a capability, denied outright, or knowingly open", () => {
    // A resource reachable by POST/PATCH/DELETE with no capability is exactly
    // the hole this work closed — a `viewer` deleting orders.
    for (const [slug, def] of Object.entries(RESOURCES)) {
      if (OPEN_TO_ALL_MEMBERS.has(slug)) continue;
      const writesDenied = ["create", "update", "delete"].every((op) => def.deny?.includes(op as never));
      expect(def.capabilities?.write || writesDenied, `${slug} has an ungated write`).toBeTruthy();
    }
  });

  it("only products create SKUs on write", () => {
    // ensureSkusForProduct resolves a product row, so the flag is meaningless —
    // and would throw — on any other table. Pinned so a copy-paste onto a
    // neighbouring resource fails here rather than at runtime.
    const declaring = Object.entries(RESOURCES)
      .filter(([, def]) => def.ensuresSkus)
      .map(([slug]) => slug);
    expect(declaring).toEqual(["products"]);
    expect(RESOURCES.products.module).toBe("products");
  });

  it("every vertical that can create an item can therefore hold stock for it", () => {
    // The SKU is written in the product's own transaction, so a workspace with
    // `products` but no `inventory` would create SKUs it can never see.
    for (const type of TENANT_TYPES) {
      const preset = new Set<string>(MODULE_PRESETS[type]);
      if (preset.has("products")) expect(preset.has("inventory"), type).toBe(true);
    }
  });

  it("the workspace audit feed is read-only", () => {
    // A feed a user can POST to can be forged, which makes it worthless as
    // evidence of what happened.
    expect(RESOURCES.activities.deny).toEqual(expect.arrayContaining(["create", "update", "delete"]));
  });

  it("staff rows cannot be created or deleted generically", () => {
    // Both also create/destroy a GoTrue identity; /api/:tenant/staff/invite owns that.
    expect(RESOURCES.staff.deny).toEqual(expect.arrayContaining(["create", "delete"]));
  });
});

describe("per-vertical config fields", () => {
  it("a warehouse workspace is not offered commerce settings", () => {
    const outside = configFieldsOutsideType("warehouse", {
      codEnabled: true,
      ga4Id: "G-1",
      pixelId: "P-1",
      currency: "EUR",
    });
    expect(outside.sort()).toEqual(["codEnabled", "ga4Id", "pixelId"]);
  });

  it("universal settings are available to every vertical", () => {
    for (const type of TENANT_TYPES) {
      expect(TYPE_CONFIG_FIELDS[type]).toEqual(expect.arrayContaining(["currency", "defaultLanguage"]));
    }
  });
});
