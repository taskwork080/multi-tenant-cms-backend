import { Injectable } from "@nestjs/common";
import { CrudService } from "../crud/crud.service";
import type { TenantDto } from "../tenant/tenant.service";

export type SearchHitType = "Product" | "Order" | "Customer" | "Category" | "Brand" | "Seller" | "Promo";

/** Mirrors the frontend's `SearchHit` in src/lib/search.ts — that shape is the contract. */
export interface SearchHit {
  type: SearchHitType;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

type Row = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v));

/**
 * One searchable resource: which CRUD slug to query, and how to turn a row into
 * a hit. Kept in the same order the old client-side `searchAll` emitted, so the
 * palette's grouping is unchanged.
 */
interface Source {
  resource: string;
  type: SearchHitType;
  /** Module entitlement is enforced by CrudService.resolve; failures are skipped. */
  toHit: (r: Row) => SearchHit;
}

const SOURCES: Source[] = [
  {
    resource: "products",
    type: "Product",
    toHit: (p) => ({
      type: "Product",
      id: str(p.id),
      title: str(p.nameEn),
      subtitle: `${str(p.status)} · stock ${str(p.stock)}`,
      href: `/products/${str(p.id)}/edit`,
    }),
  },
  {
    resource: "orders",
    type: "Order",
    toHit: (o) => ({
      type: "Order",
      id: str(o.id),
      title: str(o.code),
      subtitle: str(o.customerName),
      href: "/sales/orders",
    }),
  },
  {
    resource: "customers",
    type: "Customer",
    toHit: (c) => ({
      type: "Customer",
      id: str(c.id),
      title: str(c.name),
      subtitle: str(c.phone),
      href: "/customers",
    }),
  },
  {
    resource: "categories",
    type: "Category",
    toHit: (c) => ({
      type: "Category",
      id: str(c.id),
      title: str(c.nameEn),
      subtitle: `Level ${str(c.level)}`,
      href: "/products/categories",
    }),
  },
  {
    resource: "brands",
    type: "Brand",
    toHit: (b) => ({
      type: "Brand",
      id: str(b.id),
      title: str(b.name),
      subtitle: `${str(b.productCount)} products`,
      href: "/products/brands",
    }),
  },
  {
    resource: "sellers",
    type: "Seller",
    toHit: (s) => ({
      type: "Seller",
      id: str(s.id),
      title: str(s.name),
      subtitle: str(s.contact),
      href: "/seller-management/sellers",
    }),
  },
  {
    resource: "promo-codes",
    type: "Promo",
    toHit: (p) => ({
      type: "Promo",
      id: str(p.id),
      title: str(p.code),
      subtitle: str(p.status),
      href: "/discounts",
    }),
  },
];

@Injectable()
export class SearchService {
  constructor(private readonly crud: CrudService) {}

  /**
   * Global search for the ⌘K palette. Fans out over the CRUD list endpoint's
   * existing `?q=` ILIKE support — no new SQL, and each resource's searchable
   * columns stay defined in one place (resource-registry.ts).
   *
   * Replaces a client-side scan that required the browser to hold seven whole
   * collections in memory.
   */
  async search(tenant: TenantDto, q: string, perType = 4): Promise<SearchHit[]> {
    const term = q.trim();
    if (!term) return [];

    const results = await Promise.allSettled(
      SOURCES.map((src) =>
        this.crud.list(tenant, src.resource, { q: term, pageSize: String(perType) }),
      ),
    );

    const hits: SearchHit[] = [];
    results.forEach((res, i) => {
      // A rejected source means the tenant lacks that module — skip it rather
      // than failing the whole search.
      if (res.status !== "fulfilled") return;
      (res.value.data as Row[]).forEach((row) => hits.push(SOURCES[i].toHit(row)));
    });
    return hits;
  }
}
