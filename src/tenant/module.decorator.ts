import { SetMetadata } from "@nestjs/common";
import type { ModuleKey } from "../platform/module-presets";

export const REQUIRED_MODULES = "requiredModules";

/**
 * Requires the tenant to have bought every listed module.
 *
 * The generic CRUD surface gets this for free — each ResourceDef names its
 * `module` and CrudService.resolve checks it. Bespoke controllers had no
 * equivalent, so `/inventory/*`, `/stock-transfers/*`, `/inbound-receipts/*`,
 * `/cycle-counts/*`, `/dashboard`, `/packing-lists/*` and the product importer
 * all ran with their module locked: an e-commerce tenant without
 * `inventoryTransfers` could not *list* transfers but could still POST one.
 */
export const RequireModule = (...modules: ModuleKey[]) => SetMetadata(REQUIRED_MODULES, modules);
