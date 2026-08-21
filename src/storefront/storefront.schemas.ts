import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Storefront input validation.
//
// The three storefront tables are the only jsonb columns in the schema, so
// unlike every other resource there is no column list acting as an implicit
// contract — whatever the API accepts is what lands in the row and, for pages,
// what gets rendered to anonymous visitors. These schemas ARE the contract.
//
// This is also why storefront pages get a dedicated controller instead of a
// resource-registry entry: the generic CRUD layer copies any recognised column
// through untouched (CrudService.sanitize), which for a jsonb column means
// arbitrary caller-supplied JSON reaching a public renderer.
// ---------------------------------------------------------------------------

const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Must be a hex colour like #2563eb");

/** Relative path, absolute URL, anchor or mailto/tel — never javascript:. */
const href = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) => /^(\/[^\s]*|https?:\/\/[^\s]+|#[^\s]*|mailto:[^\s]+|tel:[^\s]+)$/i.test(v),
    "Must be a relative path, http(s) URL, anchor, mailto: or tel: link",
  );

const imageUrl = z.string().url().max(2048);

// --- Theme + SEO -------------------------------------------------------------

export const themeSchema = z.object({
  brand: hexColor,
  brandFg: hexColor,
  accent: hexColor,
  bg: hexColor,
  fg: hexColor,
  muted: hexColor,
  fontHeading: z.string().min(1).max(80),
  fontBody: z.string().min(1).max(80),
  radius: z.number().int().min(0).max(48),
  logoUrl: imageUrl.nullable(),
  faviconUrl: imageUrl.nullable(),
});

export const seoSchema = z.object({
  title: z.string().max(120).default(""),
  description: z.string().max(320).default(""),
  keywords: z.array(z.string().min(1).max(40)).max(20).default([]),
  ogImageUrl: imageUrl.nullable().default(null),
  twitterHandle: z
    .string()
    .regex(/^@[A-Za-z0-9_]{1,15}$/, "Must look like @handle")
    .nullable()
    .default(null),
  robots: z.enum(["index,follow", "noindex,nofollow"]).default("index,follow"),
});

// --- Content blocks ----------------------------------------------------------

const blockId = z.string().min(1).max(64).default(() => randomUUID());

const block = <T extends string, P extends z.ZodTypeAny>(type: T, props: P) =>
  z.object({ id: blockId, type: z.literal(type), props });

/**
 * The block catalogue. Adding a type here is half the work — the storefront
 * needs a matching renderer, and the admin a matching form. Unknown types are
 * rejected on write rather than silently stored, so a page can never contain a
 * block nothing knows how to draw.
 */
export const contentBlockSchema = z.discriminatedUnion("type", [
  block(
    "hero",
    z.object({
      heading: z.string().min(1).max(160),
      subheading: z.string().max(320).default(""),
      imageUrl: imageUrl.nullable().default(null),
      ctaLabel: z.string().max(60).default(""),
      ctaHref: href.nullable().default(null),
      align: z.enum(["left", "center", "right"]).default("center"),
    }),
  ),
  block(
    "richtext",
    z.object({
      // Rendered as HTML. Sanitised at render time in the storefront app, not
      // here: escaping on write would corrupt the stored copy on every edit.
      html: z.string().max(50_000).default(""),
    }),
  ),
  block(
    "image",
    z.object({
      url: imageUrl,
      alt: z.string().max(200).default(""),
      caption: z.string().max(200).default(""),
      href: href.nullable().default(null),
    }),
  ),
  block(
    "imageGrid",
    z.object({
      columns: z.number().int().min(2).max(6).default(3),
      images: z
        .array(z.object({ url: imageUrl, alt: z.string().max(200).default(""), href: href.nullable().default(null) }))
        .max(24)
        .default([]),
    }),
  ),
  block(
    "productGrid",
    z.object({
      heading: z.string().max(160).default(""),
      // Empty categoryId = newest across the catalogue.
      categoryId: z.string().uuid().nullable().default(null),
      limit: z.number().int().min(1).max(24).default(8),
    }),
  ),
  block(
    "cta",
    z.object({
      heading: z.string().min(1).max(160),
      body: z.string().max(320).default(""),
      buttonLabel: z.string().min(1).max(60),
      buttonHref: href,
      variant: z.enum(["solid", "outline"]).default("solid"),
    }),
  ),
  block(
    "faq",
    z.object({
      heading: z.string().max(160).default(""),
      items: z
        .array(z.object({ q: z.string().min(1).max(300), a: z.string().min(1).max(2000) }))
        .max(50)
        .default([]),
    }),
  ),
  block(
    "html",
    z.object({
      // Deliberately raw: an escape hatch for embeds. Tenant-authored and
      // tenant-scoped, so the blast radius is the tenant's own storefront.
      html: z.string().max(50_000).default(""),
    }),
  ),
]);

export const contentBlocksSchema = z.array(contentBlockSchema).max(100);

// --- Navigation --------------------------------------------------------------

const navLeaf = z.object({
  id: z.string().min(1).max(64).default(() => randomUUID()),
  label: z.string().min(1).max(60),
  href,
  external: z.boolean().default(false),
});

/** One level of nesting: a top-level entry may have children, they may not. */
export const navItemSchema = navLeaf.extend({
  children: z.array(navLeaf).max(20).optional(),
});

export const navItemsSchema = z.array(navItemSchema).max(30);

export const navLocationSchema = z.enum(["header", "footer"]);

// --- Request bodies ----------------------------------------------------------

/**
 * Hostname only. Accepts what people paste (scheme, path, port) and strips it
 * rather than bouncing them — see StorefrontService.normalizeDomain.
 */
export const customDomainSchema = z
  .string()
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "Must be a bare hostname like shop.example.com",
  );

export const configUpdateSchema = z
  .object({
    isActive: z.boolean(),
    customDomain: z.string().nullable(),
    theme: themeSchema.partial(),
    seo: seoSchema.partial(),
  })
  .partial();

/** Reserved because it serves the site root; see storefrontPages in schema.ts. */
export const HOME_SLUG = "home";

export const pageSlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single hyphens only");

export const pageCreateSchema = z.object({
  title: z.string().min(1).max(200),
  slug: pageSlugSchema,
  contentBlocks: contentBlocksSchema.default([]),
  isPublished: z.boolean().default(false),
  metaTitle: z.string().max(120).nullable().default(null),
  metaDescription: z.string().max(320).nullable().default(null),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const pageUpdateSchema = pageCreateSchema.partial();

export const navUpdateSchema = z.object({
  items: navItemsSchema,
});

// --- Public catalogue --------------------------------------------------------

/** `?brands=ASUS,Apple` — the storefront facets by name, the admin by id. */
const csv = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1).max(120)).max(40));

/**
 * Everything the storefront's catalogue listing can ask for.
 *
 * Coerced rather than strict because these arrive as query strings, and
 * bounded rather than optional-unbounded because this endpoint is anonymous:
 * `pageSize` is what stands between a scraper and the whole catalogue in one
 * request.
 *
 * `sort: "pop"` has no popularity signal to sort by yet — there is no sales
 * or view counter on products — so it means "newest first", which is what the
 * feed has always returned. Named for what the storefront calls it so the
 * contract does not change when a real signal arrives.
 */
export const publicProductQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  categoryId: z.string().uuid().optional(),
  categorySlug: z.string().max(120).optional(),
  subCategoryId: z.string().uuid().optional(),
  subCategorySlug: z.string().max(120).optional(),
  brandIds: csv.optional(),
  brands: csv.optional(),
  /** One badge label, e.g. "Best Seller" — how a storefront curates a shelf. */
  badge: z.string().trim().min(1).max(60).optional(),
  /** Only products with an offer price. The discount rail depends on it. */
  onSale: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  sort: z.enum(["pop", "lo", "hi", "new", "discount"]).default("pop"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
});

export type PublicProductQuery = z.infer<typeof publicProductQuerySchema>;

/** Brand facets are always scoped to the category being browsed, or all. */
export const publicBrandQuerySchema = publicProductQuerySchema.pick({
  categoryId: true,
  categorySlug: true,
  subCategoryId: true,
  subCategorySlug: true,
});

export type PublicBrandQuery = z.infer<typeof publicBrandQuerySchema>;

export type ThemeInput = z.infer<typeof themeSchema>;
export type SeoInput = z.infer<typeof seoSchema>;
export type ConfigUpdateInput = z.infer<typeof configUpdateSchema>;
export type PageCreateInput = z.infer<typeof pageCreateSchema>;
export type PageUpdateInput = z.infer<typeof pageUpdateSchema>;
export type NavLocation = z.infer<typeof navLocationSchema>;
