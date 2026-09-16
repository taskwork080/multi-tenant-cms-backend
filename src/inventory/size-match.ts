/**
 * Matching a packed size to a product variant.
 *
 * Packing lists record colour and size as free text typed on the floor
 * (`item_cartons.color`, `carton_sizes.size`), while the catalogue records a
 * variant as one free-text `label`. Nothing joins them, so this module holds the
 * one set of rules that decides whether "EU 38" on a carton is the variant
 * "Navy / 38".
 *
 * It is deliberately conservative: an ambiguous match resolves to nothing and
 * asks a person, because silently picking one of two candidate SKUs would move
 * real stock off the wrong shelf and leave no trace that a guess was made.
 */

/** Sizes people write differently but mean identically. */
const SIZE_ALIASES: Record<string, string> = {
  XXL: "2XL",
  XXXL: "3XL",
  XXXXL: "4XL",
  SMALL: "S",
  MEDIUM: "M",
  LARGE: "L",
  XSMALL: "XS",
  XLARGE: "XL",
  EXTRALARGE: "XL",
};

/** Scale prefixes that carry no identity — "EU 38" and "38" are one size. */
const SCALE_PREFIX = /^(SIZE|EU|UK|US|INT)\b[\s-]*/;

/**
 * A size label reduced to its identity: upper-cased, scale prefix removed,
 * punctuation and spaces stripped, then aliased.
 *
 *   "eu 38" → "38"   "  XXL " → "2XL"   "Size-M" → "M"
 */
export function normalizeSize(raw: string): string {
  const cleaned = String(raw ?? "")
    .toUpperCase()
    .trim()
    .replace(SCALE_PREFIX, "")
    .replace(/[^A-Z0-9]/g, "");
  return SIZE_ALIASES[cleaned] ?? cleaned;
}

/** Colours are compared on letters and digits only; "" means "any colour". */
export function normalizeColor(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * A variant label split into comparable parts.
 *
 * Labels in the wild are "Navy / 38", "Red - M", "M", "Black, XL" — one
 * separator vocabulary covers all of them. Each token is normalised as a size,
 * because a token is a size candidate and a colour candidate at the same time
 * and we do not know which until we compare it.
 */
export function labelTokens(label: string): string[] {
  return String(label ?? "")
    .split(/[/\-,|·]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeSize)
    .filter(Boolean);
}

export interface VariantLike {
  id: string;
  label: string;
}

export interface SizeMatch {
  variantId: string | null;
  /** Every variant that matched the size, for the UI to offer when ambiguous. */
  candidates: VariantLike[];
  reason: "matched" | "ambiguous" | "no-match";
}

/**
 * The variant a (colour, size) pair refers to.
 *
 * Size must match. Colour is used only to *narrow* — a label that carries no
 * colour still matches, because plenty of catalogues put colour in the product
 * and size in the variant. When colour narrows two candidates to one, that one
 * wins; when it narrows to none, the size-only candidates stand, so a carton
 * colour the catalogue doesn't model can't block the match.
 */
export function matchVariant(
  variants: VariantLike[],
  color: string | null | undefined,
  size: string,
): SizeMatch {
  const wantSize = normalizeSize(size);
  if (!wantSize) return { variantId: null, candidates: [], reason: "no-match" };

  const bySize = variants.filter((v) => labelTokens(v.label).includes(wantSize));
  if (bySize.length === 0) return { variantId: null, candidates: [], reason: "no-match" };
  if (bySize.length === 1) return { variantId: bySize[0].id, candidates: bySize, reason: "matched" };

  const wantColor = normalizeColor(color);
  if (wantColor) {
    const byColor = bySize.filter((v) => labelTokens(v.label).includes(wantColor));
    if (byColor.length === 1) return { variantId: byColor[0].id, candidates: byColor, reason: "matched" };
    // Narrowing to nothing leaves the size-only candidates standing rather than
    // failing the line over a colour the catalogue never modelled.
    if (byColor.length > 1) return { variantId: null, candidates: byColor, reason: "ambiguous" };
  }

  return { variantId: null, candidates: bySize, reason: "ambiguous" };
}
