import { describe, expect, it } from "vitest";
import { cartPriceSchema, orderLookupSchema, placeOrderSchema } from "./checkout.schemas";

/**
 * The checkout parse is the trust boundary for taking money.
 *
 * Everything here arrives from an anonymous browser. The single property worth
 * testing hardest is the one that cannot be recovered from later: a client must
 * not be able to state a price. The rest is bounds — a request that can reserve
 * the warehouse or store a novel is a denial-of-service with extra steps.
 */

const line = { slug: "zen14", qty: 1 };
const shipping = {
  name: "Rafi Ahmed",
  phone: "01712345678",
  address: "12 Road 7, Dhanmondi",
  district: "Dhaka",
  area: "Dhanmondi",
};

describe("cartPriceSchema", () => {
  it("accepts a minimal cart", () => {
    expect(cartPriceSchema.parse({ lines: [line] }).lines).toEqual([line]);
  });

  /**
   * The reason this file exists. `unitPrice` is not an optional field that
   * happens to be ignored downstream — it is absent from the shape, so zod
   * strips it and no later code can read it even by accident.
   */
  it("strips any price the client tries to send", () => {
    const parsed = cartPriceSchema.parse({
      lines: [{ ...line, unitPrice: 1, price: 1, lineTotal: 1 }],
      subtotal: 1,
      total: 1,
    });
    expect(parsed.lines[0]).toEqual(line);
    expect(parsed).not.toHaveProperty("subtotal");
    expect(parsed).not.toHaveProperty("total");
  });

  it("rejects an empty cart — there is nothing to price", () => {
    expect(() => cartPriceSchema.parse({ lines: [] })).toThrow();
  });

  it("caps the number of lines", () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({ slug: `p${i}`, qty: 1 }));
    expect(() => cartPriceSchema.parse({ lines })).toThrow();
  });

  it("caps quantity per line, so one request cannot reserve the warehouse", () => {
    expect(() => cartPriceSchema.parse({ lines: [{ slug: "zen14", qty: 100000 }] })).toThrow();
  });

  it("rejects a fractional or zero quantity", () => {
    expect(() => cartPriceSchema.parse({ lines: [{ slug: "zen14", qty: 1.5 }] })).toThrow();
    expect(() => cartPriceSchema.parse({ lines: [{ slug: "zen14", qty: 0 }] })).toThrow();
  });
});

describe("placeOrderSchema", () => {
  const valid = { lines: [line], shipping, paymentMethod: "cod" };

  it("accepts a guest order with no billing address", () => {
    const parsed = placeOrderSchema.parse(valid);
    expect(parsed.billing).toBeUndefined();
    expect(parsed.shipping.district).toBe("Dhaka");
  });

  it("requires a payment method — it decides the surcharge", () => {
    const { paymentMethod, ...rest } = valid;
    expect(() => placeOrderSchema.parse(rest)).toThrow();
  });

  describe("phone", () => {
    it("accepts the 11-digit local format", () => {
      expect(placeOrderSchema.parse(valid).shipping.phone).toBe("01712345678");
    });

    it("rejects a number that could not be delivered to", () => {
      for (const phone of ["12345", "+8801712345678", "not-a-phone", ""]) {
        expect(() => placeOrderSchema.parse({ ...valid, shipping: { ...shipping, phone } })).toThrow();
      }
    });
  });

  it("requires an address, not just a district", () => {
    expect(() =>
      placeOrderSchema.parse({ ...valid, shipping: { ...shipping, address: "  " } }),
    ).toThrow();
  });

  it("still refuses client-supplied totals", () => {
    const parsed = placeOrderSchema.parse({ ...valid, total: 1, totals: { total: 1 } });
    expect(parsed).not.toHaveProperty("total");
    expect(parsed).not.toHaveProperty("totals");
  });

  it("rejects a malformed email but allows none at all", () => {
    expect(placeOrderSchema.parse(valid).email).toBeUndefined();
    expect(() => placeOrderSchema.parse({ ...valid, email: "nope" })).toThrow();
    expect(placeOrderSchema.parse({ ...valid, email: "a@b.com" }).email).toBe("a@b.com");
  });
});

/**
 * The order code is quoted over the phone and guessable in four digits, so the
 * token is the only thing standing between a stranger and a customer's home
 * address. A short one would be brute-forceable at the endpoint's rate limit.
 */
describe("orderLookupSchema", () => {
  it("requires a token of real length", () => {
    expect(() => orderLookupSchema.parse({})).toThrow();
    expect(() => orderLookupSchema.parse({ token: "short" })).toThrow();
  });

  it("accepts the base64url token placement issues", () => {
    const token = "a".repeat(32);
    expect(orderLookupSchema.parse({ token }).token).toBe(token);
  });
});
