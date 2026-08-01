import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../db/db.tokens";
import { TenantDb } from "../db/tenant-db.service";
import { FulfilmentService } from "../inventory/fulfilment.service";
import type { TenantDto } from "../tenant/tenant.service";
import { AnyTable, ChildDef, RESOURCES, ResourceDef } from "./resource-registry";

export interface ListQuery {
  q?: string;
  page?: string;
  pageSize?: string;
  sort?: string; // camelCase column, prefix "-" for desc
  /**
   * Extra keys become filters on any real column:
   *   ?status=active            equality
   *   ?status=active&status=draft   IN (…)
   *   ?createdAt[gte]=2024-01-01    range (also [lte])
   *   ?shipmentNo[isnull]=false     IS NOT NULL
   */
  [key: string]: string | string[] | Record<string, string> | undefined;
}

const RESERVED_QUERY_KEYS = new Set(["q", "page", "pageSize", "sort"]);

/**
 * Coerces a raw query-string value to the column's JS type. Without this a
 * `?stock=abc` or `?active=yes` reaches the driver as a string and fails as an
 * opaque 500 instead of a 400 the caller can act on.
 */
function coerce(col: AnyPgColumn, raw: string, key: string): unknown {
  const type = col.dataType;
  if (type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new BadRequestException(`Filter "${key}" must be a number`);
    return n;
  }
  if (type === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new BadRequestException(`Filter "${key}" must be true or false`);
  }
  if (type === "date") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Filter "${key}" must be a date`);
    return d;
  }
  return raw;
}

/**
 * Builds the SQL predicate for one `?key=value` filter. Handles the three
 * shapes Express's query parser can produce: a scalar, a repeated key (array),
 * and bracket syntax (`?createdAt[gte]=…` → an object).
 */
function buildFilter(col: AnyPgColumn, key: string, value: string | string[] | Record<string, string>): SQL | undefined {
  if (Array.isArray(value)) {
    const vals = value.filter((v) => v !== "").map((v) => coerce(col, v, key));
    return vals.length ? inArray(col, vals) : undefined;
  }

  if (typeof value === "object") {
    const parts: SQL[] = [];
    for (const [op, raw] of Object.entries(value)) {
      if (raw === undefined || raw === "") continue;
      // `?col[isnull]=true|false` — nullable columns are how several UIs split
      // records into "assigned" vs "unassigned" buckets.
      if (op === "isnull") {
        if (raw === "true" || raw === "1") parts.push(isNull(col));
        else if (raw === "false" || raw === "0") parts.push(isNotNull(col));
        else throw new BadRequestException(`Filter "${key}[isnull]" must be true or false`);
        continue;
      }
      const v = coerce(col, raw, key);
      if (op === "gte") parts.push(gte(col, v));
      else if (op === "lte") parts.push(lte(col, v));
      else throw new BadRequestException(`Unsupported operator "${op}" on "${key}" (use gte/lte/isnull)`);
    }
    return parts.length ? (and(...parts) as SQL) : undefined;
  }

  return value === "" ? undefined : eq(col, coerce(col, value, key));
}
const READONLY_COLUMNS = new Set(["id", "tenantId", "createdAt", "updatedAt"]);
/** Internal child columns stripped from API payloads. */
const HIDDEN_CHILD_COLUMNS = new Set(["tenantId", "sort"]);

type Row = Record<string, unknown>;

@Injectable()
export class CrudService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly fulfilment: FulfilmentService,
  ) {}

  resolve(resource: string, tenant: TenantDto): ResourceDef {
    const def = RESOURCES[resource];
    if (!def) throw new NotFoundException(`Unknown resource "${resource}"`);
    if (def.module && !tenant.entitlements.includes(def.module)) {
      throw new ForbiddenException(`Module "${def.module}" is not enabled for this tenant`);
    }
    return def;
  }

  async list(tenant: TenantDto, resource: string, query: ListQuery) {
    const def = this.resolve(resource, tenant);
    const table = def.table;
    const cols = getTableColumns(table);

    const filters: SQL[] = [eq(table.tenantId, tenant.id)];

    if (query.q && typeof query.q === "string" && def.searchable?.length) {
      const likes = def.searchable
        .map((dbName) => Object.values(cols).find((c) => c.name === dbName))
        .filter(Boolean)
        .map((c) => ilike(c!, `%${query.q as string}%`));
      if (likes.length) filters.push(or(...likes)!);
    }

    // Equality / IN / range filters on any real column — see buildFilter.
    // Keys matching a registered flag apply that predicate instead.
    for (const [key, value] of Object.entries(query)) {
      if (RESERVED_QUERY_KEYS.has(key) || value === undefined) continue;

      const flag = def.flags?.[key];
      if (flag) {
        if (value === "true" || value === "1") filters.push(flag);
        continue;
      }

      const col = cols[key];
      if (!col) continue;
      const predicate = buildFilter(col as AnyPgColumn, key, value);
      if (predicate) filters.push(predicate);
    }

    const sortRaw = typeof query.sort === "string" ? query.sort : undefined;
    const sortKey = sortRaw?.replace(/^-/, "");
    const sortCol = sortKey ? cols[sortKey] : undefined;
    const primaryOrder: SQL = sortCol
      ? ((sortRaw!.startsWith("-") ? desc(sortCol) : asc(sortCol)) as SQL)
      : (desc(Object.values(cols).find((c) => c.name === (def.orderBy ?? "created_at")) ?? cols.id) as SQL);
    // `id` breaks ties so OFFSET paging can't drop or duplicate rows when the
    // sort column is non-unique (e.g. ?sort=status).
    const orderExprs: SQL[] = sortCol?.name === "id" ? [primaryOrder] : [primaryOrder, asc(cols.id) as SQL];

    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize ?? "50", 10) || 50));

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const where = and(...filters);
      const [rows, [{ count }]] = await Promise.all([
        tx
          .select()
          .from(table)
          .where(where)
          .orderBy(...orderExprs)
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        tx.select({ count: sql<number>`count(*)::int` }).from(table).where(where),
      ]);
      const data = await this.hydrateMany(tx, def.children, rows as Row[]);
      return { data, total: count, page, pageSize };
    });
  }

  async get(tenant: TenantDto, resource: string, id: string) {
    const def = this.resolve(resource, tenant);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(def.table)
        .where(and(eq(def.table.id, id), eq(def.table.tenantId, tenant.id)))
        .limit(1);
      if (!row) throw new NotFoundException(`${resource}/${id} not found`);
      const [hydrated] = await this.hydrateMany(tx, def.children, [row as Row]);
      return hydrated;
    });
  }

  async create(tenant: TenantDto, resource: string, body: Row) {
    const def = this.resolve(resource, tenant);
    const { values, childInputs } = this.split(def, body);
    values.tenantId = tenant.id;
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx.insert(def.table).values(values as never).returning();
      await this.writeChildren(tx, tenant.id, def.children ?? [], (row as Row).id as string, childInputs);

      // Same transaction on purpose: if the order can't be covered, the
      // reservation throws and takes the order row with it. That rollback is
      // the oversell guard — there is no moment where the order exists but
      // its stock isn't held.
      if (def.reservesStock && !this.isCancelled(row as Row)) {
        await this.fulfilment.reserveOrder(tx, tenant.id, (row as Row).id as string);
      }

      const [hydrated] = await this.hydrateMany(tx, def.children, [row as Row]);
      return hydrated;
    });
  }

  async update(tenant: TenantDto, resource: string, id: string, body: Row) {
    const def = this.resolve(resource, tenant);
    const { values, childInputs } = this.split(def, body);
    if (!Object.keys(values).length && !Object.keys(childInputs).length) {
      throw new BadRequestException("No updatable fields in body");
    }
    values.updatedAt = new Date();
    return this.tdb.forTenant(tenant.id, async (tx) => {
      // Read first: releasing has to key off the *transition* into cancelled,
      // not the final value, or re-saving an already-cancelled order would
      // release a second time.
      const before = def.reservesStock
        ? ((
            await tx
              .select()
              .from(def.table)
              .where(and(eq(def.table.id, id), eq(def.table.tenantId, tenant.id)))
              .limit(1)
          )[0] as Row | undefined)
        : undefined;

      const [row] = await tx
        .update(def.table)
        .set(values as never)
        .where(and(eq(def.table.id, id), eq(def.table.tenantId, tenant.id)))
        .returning();
      if (!row) throw new NotFoundException(`${resource}/${id} not found`);
      await this.writeChildren(tx, tenant.id, def.children ?? [], id, childInputs, { replace: true });

      if (def.reservesStock && before) {
        const wasCancelled = this.isCancelled(before);
        const nowCancelled = this.isCancelled(row as Row);
        if (!wasCancelled && nowCancelled) {
          await this.fulfilment.releaseOrder(tx, tenant.id, id, "cancel");
        } else if (wasCancelled && !nowCancelled) {
          // Reinstated — put the hold back, and fail loudly if stock has since
          // gone to someone else rather than quietly reviving an unfillable order.
          await this.fulfilment.reserveOrder(tx, tenant.id, id);
        }
      }

      const [hydrated] = await this.hydrateMany(tx, def.children, [row as Row]);
      return hydrated;
    });
  }

  /** Statuses that mean "this order will not ship", so its holds are freed. */
  private isCancelled(row: Row): boolean {
    const status = String(row.deliveryStatus ?? "").toLowerCase();
    return status === "cancelled" || status === "canceled" || status === "failed";
  }

  async remove(tenant: TenantDto, resource: string, id: string) {
    const def = this.resolve(resource, tenant);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .delete(def.table)
        .where(and(eq(def.table.id, id), eq(def.table.tenantId, tenant.id)))
        .returning(); // children removed by ON DELETE CASCADE
      if (!row) throw new NotFoundException(`${resource}/${id} not found`);
      return { deleted: true, id };
    });
  }

  // --- child hydration ------------------------------------------------------

  /** Loads child rows for a page of parents and attaches them as nested arrays. */
  private async hydrateMany(tx: Db, children: ChildDef[] | undefined, rows: Row[]): Promise<Row[]> {
    if (!children?.length || !rows.length) return rows;
    const ids = rows.map((r) => r.id as string);

    for (const child of children) {
      const cols = getTableColumns(child.table);
      const fkCol = cols[child.fk];
      const orderCol = cols[child.orderBy ?? (cols.sort ? "sort" : "at")] ?? cols.id;

      const childRows = (await tx
        .select()
        .from(child.table)
        .where(inArray(fkCol, ids))
        .orderBy(asc(orderCol))) as Row[];

      const hydratedChildren = await this.hydrateMany(tx, child.children, childRows);

      const byParent = new Map<string, unknown[]>();
      for (const c of hydratedChildren) {
        const parentId = c[child.fk] as string;
        if (!byParent.has(parentId)) byParent.set(parentId, []);
        byParent.get(parentId)!.push(child.scalar ? c[child.scalar] : this.presentChild(child, c));
      }
      for (const row of rows) {
        row[child.field] = byParent.get(row.id as string) ?? [];
      }
    }
    return rows;
  }

  /** Strips FK/tenant/sort bookkeeping columns from child API payloads. */
  private presentChild(child: ChildDef, row: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === child.fk || HIDDEN_CHILD_COLUMNS.has(k)) continue;
      out[k] = v;
    }
    return out;
  }

  // --- child persistence ------------------------------------------------------

  /**
   * Inserts child rows for the given parent. With `replace`, existing children
   * of each *provided* field are deleted first (absent fields stay untouched).
   * Client-supplied child ids are ignored — the database assigns new ones.
   */
  private async writeChildren(
    tx: Db,
    tenantId: string,
    defs: ChildDef[],
    parentId: string,
    inputs: Record<string, unknown>,
    opts: { replace?: boolean } = {},
  ) {
    for (const child of defs) {
      const input = inputs[child.field];
      if (input === undefined) continue;
      if (!Array.isArray(input)) throw new BadRequestException(`"${child.field}" must be an array`);

      const cols = getTableColumns(child.table);
      const fkCol = cols[child.fk];
      if (opts.replace) {
        await tx.delete(child.table).where(eq(fkCol, parentId));
      }

      let sort = 0;
      for (const entry of input) {
        const nested: Record<string, unknown> = {};
        let values: Row;
        if (child.scalar) {
          values = { [child.scalar]: entry };
        } else {
          if (typeof entry !== "object" || entry === null) {
            throw new BadRequestException(`"${child.field}" entries must be objects`);
          }
          values = this.sanitize(child.table, entry as Row);
          for (const sub of child.children ?? []) {
            if ((entry as Row)[sub.field] !== undefined) nested[sub.field] = (entry as Row)[sub.field];
          }
        }
        values.tenantId = tenantId;
        values[child.fk] = parentId;
        if (cols.sort) values.sort = sort++;

        const [inserted] = await tx.insert(child.table).values(values as never).returning();
        if (child.children?.length) {
          await this.writeChildren(tx, tenantId, child.children, (inserted as Row).id as string, nested);
        }
      }
    }
  }

  /** Separates direct column values from nested child arrays in the body. */
  private split(def: ResourceDef, body: Row): { values: Row; childInputs: Record<string, unknown> } {
    if (!body || typeof body !== "object") throw new BadRequestException("Body must be a JSON object");
    const childInputs: Record<string, unknown> = {};
    for (const child of def.children ?? []) {
      if (body[child.field] !== undefined) childInputs[child.field] = body[child.field];
    }
    return { values: this.sanitize(def.table, body), childInputs };
  }

  /**
   * Keeps only real, writable columns; ISO strings on timestamp columns become
   * Dates and empty strings on nullable columns become null so optional form
   * fields clear cleanly.
   */
  private sanitize(table: AnyTable, body: Row): Row {
    const cols = getTableColumns(table);
    const out: Row = {};
    for (const [key, value] of Object.entries(body)) {
      if (READONLY_COLUMNS.has(key)) continue;
      const col = cols[key];
      if (!col) continue;
      let v: unknown = value;
      if (col.columnType === "PgTimestamp" && typeof v === "string") v = new Date(v);
      if (v === "" && !col.notNull) v = null;
      out[key] = v;
    }
    return out;
  }
}
