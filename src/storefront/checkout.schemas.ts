import { z } from "zod";

// ---------------------------------------------------------------------------
// Public checkout input validation.
//
// Every field here arrives from an anonymous browser, so this file is the
// entire trust boundary for order placement. Two rules it enforces by
// construction:
//
//  1. **No prices.** There is deliberately no `unitPrice`, `subtotal` or
//     `total` anywhere in these shapes. The server resolves every figure from
//     the catalogue; a client that sends one is sending a field the parser
//     drops. Accepting a price from the browser is how a storefront gets
//     charged ৳1 for a laptop.
//  2. **Bounded.** Quantities, line counts and string lengths are capped, so a
//     single request cannot reserve the warehouse or store a novel.
// ---------------------------------------------------------------------------

/** Bangladeshi mobile number, matching the storefront's own validation. */
const phone = z
  .string()
  .trim()
  .regex(/^0\d{9,10}$/, "Enter a valid Bangladeshi phone number");

const party = z.object({
  name: z.string().trim().min(1).max(120),
  phone,
  address: z.string().trim().min(1).max(500),
});

export const cartLineSchema = z.object({
  /** Product slug — what the storefront's URLs use. */
  slug: z.string().trim().min(1).max(200),
  qty: z.number().int().min(1).max(999),
  /** Optional variant selection; priced from the variant when present. */
  variantId: z.string().uuid().optional(),
});

export const cartPriceSchema = z.object({
  lines: z.array(cartLineSchema).min(1).max(50),
  /** Drives the delivery zone lookup. Absent means "not chosen yet". */
  district: z.string().trim().max(120).optional(),
  paymentMethod: z.string().trim().max(40).optional(),
  promoCode: z.string().trim().max(40).optional(),
});

export type CartPriceInput = z.infer<typeof cartPriceSchema>;

export const placeOrderSchema = cartPriceSchema.extend({
  shipping: party.extend({
    district: z.string().trim().min(1).max(120),
    area: z.string().trim().min(1).max(120),
  }),
  /** Absent means "same as shipping" — the storefront's default. */
  billing: party.optional(),
  email: z.string().trim().email().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  paymentMethod: z.string().trim().min(1).max(40),
});

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const orderLookupSchema = z.object({
  token: z.string().trim().min(16).max(120),
});
