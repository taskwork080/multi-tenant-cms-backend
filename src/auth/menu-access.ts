/**
 * Menu permissions — which nav items a role may see.
 *
 * Keys live in the same `role_permissions.permission` column as the capability
 * keys (`catalog.view`, `staff.manage`, …). Those contain no ":" or "/", so the
 * `menu:` prefix partitions the two families cleanly and no migration was
 * needed to add this.
 *
 * This is UX scoping, not an authorization boundary: a user with a trimmed menu
 * can still reach the REST API directly. Real authz stays app-role + RLS. That
 * is precisely why every ambiguous case below resolves to *unrestricted* —
 * failing open costs nothing here, and failing closed locks people out.
 *
 * Mirrored on the frontend at multi-tenant-cms/src/lib/access.ts — keep the two
 * in step.
 */

export const MENU_PREFIX = "menu:";
/** Every menu, including ones added in future releases. */
export const MENU_ALL = "menu:*";
/** Deliberately no menus. Distinguishes "chose nothing" from "never chose". */
export const MENU_NONE = "menu:none";

export interface MenuAccess {
  /** When true, `hrefs` is empty and meaningless — the role sees everything. */
  unrestricted: boolean;
  hrefs: string[];
}

const UNRESTRICTED: MenuAccess = { unrestricted: true, hrefs: [] };

export function isMenuKey(permission: string): boolean {
  return permission.startsWith(MENU_PREFIX);
}

/**
 * Resolve a role's stored permission array into the set of nav hrefs it may see.
 *
 * Precedence:
 *   1. bypass (platform_admin / owner)          -> unrestricted
 *   2. no staff row, or staff row has no role   -> unrestricted
 *   3. contains "menu:*"                        -> unrestricted
 *   4. contains no "menu:" key at all           -> unrestricted  (legacy roles)
 *   5. otherwise                                -> exactly the listed hrefs
 *
 * Rule 4 is what makes this shippable without a backfill: every role that
 * predates the feature has zero menu keys, so nothing changes for anyone until
 * someone deliberately edits a role. The editor always writes at least one
 * menu key (specific hrefs, MENU_ALL, or MENU_NONE), so "unrestricted by
 * absence" is a legacy state that decays to an explicit one on first save.
 */
export function resolveMenuAccess(
  permissions: string[],
  opts: { bypass: boolean; hasRole: boolean },
): MenuAccess {
  if (opts.bypass || !opts.hasRole) return UNRESTRICTED;

  const menuKeys = permissions.filter(isMenuKey);
  if (menuKeys.length === 0) return UNRESTRICTED; // rule 4 — legacy role
  if (menuKeys.includes(MENU_ALL)) return UNRESTRICTED;

  // MENU_NONE is a marker, not an href: it counts for rule 4 above (so the role
  // reads as explicit) but contributes nothing here.
  const hrefs = menuKeys
    .filter((k) => k !== MENU_NONE)
    .map((k) => k.slice(MENU_PREFIX.length))
    .filter((href) => href.startsWith("/"));

  return { unrestricted: false, hrefs: Array.from(new Set(hrefs)) };
}
