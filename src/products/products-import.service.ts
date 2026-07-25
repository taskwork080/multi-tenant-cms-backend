import { BadRequestException, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import * as s from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";

/** Columns accepted by the import file, in template order. */
export const IMPORT_COLUMNS = [
  "name_en",
  "name_bn",
  "style_code",
  "category",
  "sub_category",
  "brand",
  "seller",
  "unit",
  "price",
  "offer_price",
  "stock",
  "stock_mode",
  "min_order_qty",
  "max_order_qty",
  "short_desc_en",
  "description_en",
  "country_origin",
  "tags",
  "status",
  "image_url",
] as const;

export interface ImportRowError {
  row: number;
  field?: string;
  message: string;
}

export interface ImportResult {
  total: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
}

const MAX_ROWS = 1000;
const UNITS = ["g", "kg", "ml", "l", "pcs"] as const;

/** Blank cells arrive as "" or undefined; treat both as absent. */
const blankToUndefined = (v: unknown) =>
  v === "" || v === null || v === undefined ? undefined : v;

const optionalText = z.preprocess(blankToUndefined, z.coerce.string().trim().optional());
const optionalNumber = z.preprocess(blankToUndefined, z.coerce.number().optional());

const importRowSchema = z.object({
  name_en: z.coerce.string().trim().min(1, "name_en is required"),
  name_bn: optionalText,
  style_code: optionalText,
  category: optionalText,
  sub_category: optionalText,
  brand: optionalText,
  seller: optionalText,
  unit: z.preprocess(blankToUndefined, z.enum(UNITS).default("pcs")),
  price: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(0)),
  offer_price: optionalNumber.refine((v) => v === undefined || v >= 0, "offer_price cannot be negative"),
  stock: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(0)),
  stock_mode: z.preprocess(blankToUndefined, z.enum(["always", "tracked"]).default("tracked")),
  min_order_qty: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  max_order_qty: optionalNumber.refine((v) => v === undefined || v >= 1, "max_order_qty must be at least 1"),
  short_desc_en: optionalText,
  description_en: optionalText,
  country_origin: optionalText,
  tags: optionalText,
  status: z.preprocess(blankToUndefined, z.enum(["active", "draft"]).default("draft")),
  image_url: optionalText,
});

type ImportRow = z.infer<typeof importRowSchema>;

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "product"
  );
}

@Injectable()
export class ProductsImportService {
  constructor(private readonly tdb: TenantDb) {}

  /** The CSV header row handed to users as a starting point. */
  template(): string {
    return `${IMPORT_COLUMNS.join(",")}\n`;
  }

  /**
   * Parses a CSV/XLSX buffer and writes products in one transaction. Row-level
   * problems are collected rather than thrown, so a mostly-good file still
   * imports its valid rows.
   */
  async import(
    tenantId: string,
    buffer: Buffer,
    mode: "create" | "upsert",
  ): Promise<ImportResult> {
    const raw = this.parse(buffer);
    if (raw.length === 0) throw new BadRequestException("The file has no data rows");
    if (raw.length > MAX_ROWS) {
      throw new BadRequestException(`Too many rows (${raw.length}); the limit is ${MAX_ROWS}`);
    }

    const errors: ImportRowError[] = [];
    const parsed: { row: number; data: ImportRow }[] = [];

    raw.forEach((entry, i) => {
      // +2: sheet rows are 1-based and row 1 is the header.
      const rowNo = i + 2;
      const result = importRowSchema.safeParse(entry);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({ row: rowNo, field: issue.path.join(".") || undefined, message: issue.message });
        }
        return;
      }
      parsed.push({ row: rowNo, data: result.data });
    });

    if (parsed.length === 0) {
      return { total: raw.length, imported: 0, updated: 0, skipped: raw.length, errors };
    }

    return this.tdb.forTenant(tenantId, async (tx) => {
      const refs = await this.loadReferences(tx, tenantId);
      const usedSlugs = new Set(
        (await tx.select({ slug: s.products.slug }).from(s.products).where(eq(s.products.tenantId, tenantId))).map(
          (r) => r.slug,
        ),
      );

      let imported = 0;
      let updated = 0;

      for (const { row, data } of parsed) {
        const resolved = this.resolveReferences(row, data, refs, errors);
        if (!resolved) continue;

        const existing = mode === "upsert" ? await this.findExisting(tx, tenantId, data) : null;
        const values = {
          styleCode: data.style_code ?? null,
          nameEn: data.name_en,
          nameBn: data.name_bn ?? null,
          shortDescEn: data.short_desc_en ?? null,
          descriptionEn: data.description_en ?? null,
          categoryId: resolved.categoryId,
          subCategoryId: resolved.subCategoryId,
          brandId: resolved.brandId,
          sellerId: resolved.sellerId,
          countryOrigin: data.country_origin ?? null,
          price: data.price,
          offerPrice: data.offer_price ?? null,
          unit: data.unit,
          minOrderQty: data.min_order_qty,
          maxOrderQty: data.max_order_qty ?? null,
          stockMode: data.stock_mode,
          stock: data.stock,
          imageUrl: data.image_url ?? null,
          status: data.status,
        };

        let productId: string;
        if (existing) {
          await tx
            .update(s.products)
            .set({ ...values, updatedAt: new Date() })
            .where(and(eq(s.products.id, existing.id), eq(s.products.tenantId, tenantId)));
          productId = existing.id;
          updated++;
        } else {
          const slug = this.uniqueSlug(slugify(data.name_en), usedSlugs);
          const [inserted] = await tx
            .insert(s.products)
            .values({ ...values, tenantId, slug })
            .returning({ id: s.products.id });
          productId = inserted.id;
          imported++;
        }

        await this.writeTags(tx, tenantId, productId, data.tags);
        await this.writeCoverImage(tx, tenantId, productId, data.image_url);
      }

      return {
        total: raw.length,
        imported,
        updated,
        skipped: raw.length - imported - updated,
        errors,
      };
    });
  }

  // --- parsing ---------------------------------------------------------------

  private parse(buffer: Buffer): Record<string, unknown>[] {
    let book: XLSX.WorkBook;
    try {
      book = XLSX.read(buffer, { type: "buffer" });
    } catch {
      throw new BadRequestException("Could not read the file — expected CSV or XLSX");
    }
    const sheetName = book.SheetNames[0];
    if (!sheetName) throw new BadRequestException("The workbook has no sheets");

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[sheetName], { defval: "" });
    // Normalise headers so "Name EN" and "name_en" both land on name_en.
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[key.trim().toLowerCase().replace(/\s+/g, "_")] = typeof value === "string" ? value.trim() : value;
      }
      return out;
    });
  }

  // --- reference resolution --------------------------------------------------

  private async loadReferences(tx: Db, tenantId: string) {
    const [categories, brands, sellers] = await Promise.all([
      tx
        .select({ id: s.categories.id, name: s.categories.nameEn, parentId: s.categories.parentId })
        .from(s.categories)
        .where(eq(s.categories.tenantId, tenantId)),
      tx.select({ id: s.brands.id, name: s.brands.name }).from(s.brands).where(eq(s.brands.tenantId, tenantId)),
      tx.select({ id: s.sellers.id, name: s.sellers.name }).from(s.sellers).where(eq(s.sellers.tenantId, tenantId)),
    ]);
    const index = <T extends { id: string; name: string }>(rows: T[]) =>
      new Map(rows.map((r) => [r.name.trim().toLowerCase(), r]));
    return { categories: index(categories), brands: index(brands), sellers: index(sellers) };
  }

  /**
   * Maps the human-readable name columns onto ids. An unknown name is a row
   * error rather than a silent null, so a typo never quietly loses data.
   */
  private resolveReferences(
    row: number,
    data: ImportRow,
    refs: Awaited<ReturnType<ProductsImportService["loadReferences"]>>,
    errors: ImportRowError[],
  ) {
    const lookup = (field: string, value: string | undefined, map: Map<string, { id: string }>) => {
      if (!value) return { ok: true as const, id: null };
      const hit = map.get(value.toLowerCase());
      if (!hit) {
        errors.push({ row, field, message: `Unknown ${field}: "${value}"` });
        return { ok: false as const, id: null };
      }
      return { ok: true as const, id: hit.id };
    };

    const category = lookup("category", data.category, refs.categories);
    const subCategory = lookup("sub_category", data.sub_category, refs.categories);
    const brand = lookup("brand", data.brand, refs.brands);
    const seller = lookup("seller", data.seller, refs.sellers);
    if (!category.ok || !subCategory.ok || !brand.ok || !seller.ok) return null;

    return {
      categoryId: category.id,
      subCategoryId: subCategory.id,
      brandId: brand.id,
      sellerId: seller.id,
    };
  }

  private async findExisting(tx: Db, tenantId: string, data: ImportRow) {
    if (data.style_code) {
      const [byCode] = await tx
        .select({ id: s.products.id })
        .from(s.products)
        .where(and(eq(s.products.tenantId, tenantId), eq(s.products.styleCode, data.style_code)))
        .limit(1);
      if (byCode) return byCode;
    }
    const [bySlug] = await tx
      .select({ id: s.products.id })
      .from(s.products)
      .where(and(eq(s.products.tenantId, tenantId), eq(s.products.slug, slugify(data.name_en))))
      .limit(1);
    return bySlug ?? null;
  }

  /** products_tenant_slug is unique, so collisions get a -2, -3… suffix. */
  private uniqueSlug(base: string, used: Set<string>): string {
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  }

  // --- children --------------------------------------------------------------

  private async writeTags(tx: Db, tenantId: string, productId: string, raw: string | undefined) {
    if (raw === undefined) return;
    const tags = raw
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    await tx.delete(s.productTags).where(eq(s.productTags.productId, productId));
    if (tags.length === 0) return;
    await tx.insert(s.productTags).values(tags.map((tag, sort) => ({ tenantId, productId, tag, sort })));
  }

  /**
   * The import carries one cover image. It seeds the gallery for new products
   * but never rewrites a gallery curated in the wizard.
   */
  private async writeCoverImage(tx: Db, tenantId: string, productId: string, url: string | undefined) {
    if (!url) return;
    const [existing] = await tx
      .select({ id: s.productImages.id })
      .from(s.productImages)
      .where(eq(s.productImages.productId, productId))
      .limit(1);
    if (existing) return;
    await tx.insert(s.productImages).values({ tenantId, productId, url, sort: 0 });
  }
}
