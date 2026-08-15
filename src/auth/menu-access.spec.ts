import { describe, expect, it } from "vitest";
import { MENU_ALL, MENU_NONE, isMenuKey, resolveMenuAccess } from "./menu-access";
import { isCapabilityKey } from "./capabilities";

/**
 * All five precedence rules, because this function fails OPEN in four of them
 * and each of those is a deliberate decision that should not be "simplified"
 * away by someone reading it later without the reasoning.
 */
describe("resolveMenuAccess", () => {
  const opts = { bypass: false, hasRole: true };

  it("rule 1 — platform_admin / owner bypass everything", () => {
    expect(resolveMenuAccess(["menu:/dashboard"], { bypass: true, hasRole: true }).unrestricted).toBe(true);
  });

  it("rule 2 — no staff row, or a role-less staff row, is unrestricted", () => {
    expect(resolveMenuAccess(["menu:/dashboard"], { bypass: false, hasRole: false }).unrestricted).toBe(true);
  });

  it("rule 3 — menu:* is unrestricted", () => {
    expect(resolveMenuAccess([MENU_ALL, "menu:/dashboard"], opts).unrestricted).toBe(true);
  });

  it("rule 4 — a role with only capability keys is unrestricted (legacy, pre-menus)", () => {
    expect(resolveMenuAccess(["catalog.view", "orders.manage"], opts).unrestricted).toBe(true);
  });

  it("rule 5 — otherwise, exactly the listed hrefs", () => {
    const access = resolveMenuAccess(["menu:/inventory", "menu:/packing", "catalog.view"], opts);
    expect(access.unrestricted).toBe(false);
    expect(access.hrefs.sort()).toEqual(["/inventory", "/packing"]);
  });

  it("menu:none is an explicit empty choice, not an absence", () => {
    const access = resolveMenuAccess([MENU_NONE], opts);
    // Explicit: it counts as "configured" (so rule 4 does not fire) but grants nothing.
    expect(access.unrestricted).toBe(false);
    expect(access.hrefs).toEqual([]);
  });

  it("drops malformed keys and de-duplicates", () => {
    const access = resolveMenuAccess(["menu:/a", "menu:/a", "menu:not-a-path"], opts);
    expect(access.hrefs).toEqual(["/a"]);
  });
});

/**
 * Menu keys and capability keys share `role_permissions.permission`. The two
 * predicates must never both claim the same string, or a role's capabilities
 * would leak into its menu (or worse, a menu key would read as a capability
 * and make an unconfigured role look configured).
 */
describe("permission namespace split", () => {
  const menuKeys = ["menu:*", "menu:none", "menu:/inventory/inbound"];
  const capabilityKeys = ["catalog.view", "inventory.receive", "storefront.manage"];

  it.each(menuKeys)("%s is a menu key and not a capability", (k) => {
    expect(isMenuKey(k)).toBe(true);
    expect(isCapabilityKey(k)).toBe(false);
  });

  it.each(capabilityKeys)("%s is a capability and not a menu key", (k) => {
    expect(isCapabilityKey(k)).toBe(true);
    expect(isMenuKey(k)).toBe(false);
  });
});
