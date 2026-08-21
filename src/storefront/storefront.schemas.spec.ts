import { describe, expect, it } from "vitest";
import { publicBrandQuerySchema, publicProductQuerySchema } from "./storefront.schemas";

/**
 * The public catalogue query is the input boundary of an anonymous endpoint.
 *
 * Everything here arrives as a query string from the open internet, so the
 * parse is what stands between a caller and either an unbounded response or a
 * filter that silently does nothing. The SQL these values drive is covered by
 * the endpoint checks; this covers the parse.
 */
describe("publicProductQuerySchema", () => {
  const parse = (q: Record<string, string>) => publicProductQuerySchema.parse(q);

  describe("paging", () => {
    it("defaults to the first page at 24", () => {
      expect(parse({})).toMatchObject({ page: 1, pageSize: 24 });
    });

    it("coerces the strings a query string actually delivers", () => {
      expect(parse({ page: "3", pageSize: "12" })).toMatchObject({ page: 3, pageSize: 12 });
    });

    /**
     * The cap is the whole reason this is a schema and not a `Number()`.
     * Without it one request walks the entire catalogue.
     */
    it("refuses a pageSize above the cap rather than clamping it", () => {
      expect(() => parse({ pageSize: "500" })).toThrow();
    });

    it("refuses page 0 — offsets would go negative", () => {
      expect(() => parse({ page: "0" })).toThrow();
    });
  });

  describe("brand facets", () => {
    it("splits the comma-separated form the storefront puts in its URLs", () => {
      expect(parse({ brands: "ASUS,Apple,Lenovo" }).brands).toEqual(["ASUS", "Apple", "Lenovo"]);
    });

    it("tolerates the spacing and trailing commas a hand-edited URL carries", () => {
      expect(parse({ brands: "ASUS, Apple ,," }).brands).toEqual(["ASUS", "Apple"]);
    });

    it("leaves brands undefined when absent, so no filter is applied", () => {
      expect(parse({}).brands).toBeUndefined();
    });

    /**
     * An empty string is a cleared facet, not "match nothing" — it must parse
     * to an empty list the service then ignores, never to `[""]`, which would
     * filter the catalogue down to brands named "".
     */
    it("treats an empty value as no selection", () => {
      expect(parse({ brands: "" }).brands).toEqual([]);
    });
  });

  describe("price", () => {
    it("coerces both bounds", () => {
      expect(parse({ priceMin: "5000", priceMax: "150000" })).toMatchObject({
        priceMin: 5000,
        priceMax: 150000,
      });
    });

    it("rejects a negative floor", () => {
      expect(() => parse({ priceMin: "-1" })).toThrow();
    });

    it("rejects a non-numeric bound instead of quietly dropping the filter", () => {
      expect(() => parse({ priceMax: "cheap" })).toThrow();
    });
  });

  describe("sort", () => {
    it('defaults to "pop"', () => {
      expect(parse({}).sort).toBe("pop");
    });

    it("accepts the storefront's own vocabulary", () => {
      expect(parse({ sort: "lo" }).sort).toBe("lo");
      expect(parse({ sort: "hi" }).sort).toBe("hi");
    });

    it("rejects anything else — an unknown sort must not fall through to a default silently", () => {
      expect(() => parse({ sort: "price_asc" })).toThrow();
    });
  });

  describe("category", () => {
    it("carries a slug through untouched, for /category/laptop style URLs", () => {
      expect(parse({ categorySlug: "laptop" }).categorySlug).toBe("laptop");
    });

    it("requires an id to actually be a uuid", () => {
      expect(() => parse({ categoryId: "laptop" })).toThrow();
    });
  });
});

/**
 * Brand facets must be counted over the same scope the listing is filtered by,
 * so the facet schema is a strict subset of the listing's — if it drifts, a
 * facet starts offering a brand whose products the listing then filters out.
 */
describe("publicBrandQuerySchema", () => {
  it("keeps the category scope", () => {
    expect(publicBrandQuerySchema.parse({ categorySlug: "laptop" })).toEqual({
      categorySlug: "laptop",
    });
  });

  it("carries no paging or sort of its own", () => {
    const parsed = publicBrandQuerySchema.parse({ page: "2", sort: "lo", pageSize: "48" });
    expect(parsed).not.toHaveProperty("page");
    expect(parsed).not.toHaveProperty("sort");
    expect(parsed).not.toHaveProperty("pageSize");
  });
});
