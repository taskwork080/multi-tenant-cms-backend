import { randomBytes } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import {
  customers,
  orderItems,
  orders,
  productPricingTiers,
  products,
  productVariants,
  promoCodes,
  storefrontDeliveryZones,
  storefrontPaymentMethods,
  taxRates,
} from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { FulfilmentService } from "../inventory/fulfilment.service";
import type { TenantDto } from "../tenant/tenant.service";
import { withOrderCode } from "../workflows/order-code";
import type { CartPriceInput, PlaceOrderInput } from "./checkout.schemas";

/**
 * Pricing and order placement for anonymous shoppers.
 *
 * The single rule this service exists to enforce: **the client never sets a
 * price.** Both entry points take slugs and quantities, resolve every figure
 * from the catalogue, and return (or store) the result. A tampered request can
 * change *what* is bought, never *what it costs* — which is the difference
 * between a storefront and an honour system.
 *
 * `POST /cart/price` and `POST /orders` deliberately share `priceCart` rather
 * than each doing their own arithmetic. Two implementations would drift, and
 * the day they disagree the shopper is shown one total and charged another.
 */

export interface PricedLine {
  slug: string;
  name: string;
  qty: number;
  /** What this line is billed at before discounts — the pre-sale list price. */
  listPrice: number;
  /** What the shopper actually pays per unit. */
  unitPrice: number;
  lineTotal: number;
  imageUrl: string | null;
  variantId: string | null;
  variantLabel: string | null;
  productId: string;
}

export interface CartTotals {
  subtotal: number;
  savings: number;
  discount: number;
  delivery: number;
  paymentCharge: number;
  tax: number;
  total: number;
}

export interface PricedCart {
  lines: PricedLine[];
  totals: CartTotals;
  promo: { code: string; applied: boolean; message: string } | null;
  currency: string;
  currencySymbol: string;
}

/** Rounded to whole units — the storefront quotes in taka, not paisa. */
const money = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class PublicCheckoutService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly fulfilment: FulfilmentService,
  ) {}

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  /**
   * A quote for a cart, on its own transaction.
   *
   * The entry point for `POST /cart/price`. `placeOrder` calls `priceCart`
   * directly instead, inside the transaction that writes the order, so the
   * prices it stores are the ones it read.
   */
  async quoteCart(tenant: TenantDto, input: CartPriceInput): Promise<PricedCart> {
    const priced = await this.tdb.forTenant(tenant.id, (tx) => this.priceCart(tx, tenant, input));
    // `productId` is how placeOrder writes order_items; a shopper has no use
    // for an internal uuid and this response goes to the open internet. Same
    // rule as every other public DTO here — nothing leaves that wasn't chosen.
    return { ...priced, lines: priced.lines.map(({ productId, ...line }) => line) as PricedLine[] };
  }

  /**
   * Resolves a cart of slugs and quantities into money.
   *
   * Order of operations matters and mirrors what the storefront displays:
   * line totals → list-price savings → promo discount → delivery → tax →
   * payment surcharge. A promo can never take the payable below zero, and the
   * payment surcharge is charged on what is actually owed, not on the subtotal.
   */
  async priceCart(tx: Db, tenant: TenantDto, input: CartPriceInput): Promise<PricedCart> {
    const lines = await this.resolveLines(tx, tenant.id, input.lines);

    const subtotal = lines.reduce((sum, l) => sum + l.listPrice * l.qty, 0);
    const selling = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const savings = subtotal - selling;

    const promo = input.promoCode
      ? await this.resolvePromo(tx, tenant.id, input.promoCode, selling)
      : null;
    const promoDiscount = promo?.applied ? promo.amount : 0;

    // Never below zero, even stacked on top of list-price savings.
    const discount = Math.min(savings + promoDiscount, subtotal);

    const method = input.paymentMethod
      ? await this.resolvePaymentMethod(tx, tenant.id, input.paymentMethod)
      : null;

    const delivery = method?.skipsDelivery
      ? 0
      : await this.resolveDeliveryFee(tx, tenant.id, input.district);

    const taxable = Math.max(0, subtotal - discount);
    const tax = await this.resolveTax(tx, tenant.id, taxable);

    const payable = taxable + delivery + tax;
    const paymentCharge = method ? Math.round(payable * method.feePct) : 0;

    return {
      lines,
      totals: {
        subtotal: money(subtotal),
        savings: money(savings),
        discount: money(discount),
        delivery: money(delivery),
        paymentCharge: money(paymentCharge),
        tax: money(tax),
        total: money(payable + paymentCharge),
      },
      promo: promo ? { code: promo.code, applied: promo.applied, message: promo.message } : null,
      currency: tenant.config.currency,
      currencySymbol: tenant.config.currencySymbol,
    };
  }

  /**
   * Slugs and quantities in, priced lines out.
   *
   * A slug that does not resolve to an active product is an error rather than a
   * silently dropped line: the shopper is looking at a cart that contains it,
   * and quietly charging them for less than they see is worse than telling them
   * something has gone.
   */
  private async resolveLines(
    tx: Db,
    tenantId: string,
    input: CartPriceInput["lines"],
  ): Promise<PricedLine[]> {
    const slugs = [...new Set(input.map((l) => l.slug))];
    const rows = await tx
      .select({
        id: products.id,
        slug: products.slug,
        name: products.nameEn,
        price: products.price,
        offerPrice: products.offerPrice,
        imageUrl: products.imageUrl,
        minOrderQty: products.minOrderQty,
        maxOrderQty: products.maxOrderQty,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.status, "active"),
          inArray(products.slug, slugs),
        ),
      );
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    const missing = slugs.filter((s) => !bySlug.has(s));
    if (missing.length) {
      throw new BadRequestException(
        `No longer available: ${missing.join(", ")}. Remove it from your cart to continue.`,
      );
    }

    const ids = rows.map((r) => r.id);
    const [tiers, variants] = await Promise.all([
      ids.length
        ? tx
            .select({
              productId: productPricingTiers.productId,
              minQty: productPricingTiers.minQty,
              unitPrice: productPricingTiers.unitPrice,
            })
            .from(productPricingTiers)
            .where(
              and(
                eq(productPricingTiers.tenantId, tenantId),
                inArray(productPricingTiers.productId, ids),
              ),
            )
            .orderBy(asc(productPricingTiers.minQty))
        : [],
      ids.length
        ? tx
            .select({
              id: productVariants.id,
              productId: productVariants.productId,
              label: productVariants.label,
              price: productVariants.price,
              originalPrice: productVariants.originalPrice,
            })
            .from(productVariants)
            .where(
              and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, ids)),
            )
        : [],
    ]);

    const tiersByProduct = new Map<string, { minQty: number; unitPrice: number }[]>();
    for (const t of tiers) {
      tiersByProduct.set(t.productId, [...(tiersByProduct.get(t.productId) ?? []), t]);
    }
    const variantById = new Map(variants.map((v) => [v.id, v]));

    return input.map((line) => {
      const product = bySlug.get(line.slug)!;

      if (line.qty < product.minOrderQty) {
        throw new BadRequestException(
          `${product.name} has a minimum order of ${product.minOrderQty}.`,
        );
      }
      if (product.maxOrderQty !== null && line.qty > product.maxOrderQty) {
        throw new BadRequestException(
          `${product.name} is limited to ${product.maxOrderQty} per order.`,
        );
      }

      const variant = line.variantId ? variantById.get(line.variantId) : undefined;
      if (line.variantId && (!variant || variant.productId !== product.id)) {
        throw new BadRequestException(`That option is no longer available for ${product.name}.`);
      }

      // Precedence, most specific first: a chosen variant, then a quantity
      // tier the order qualifies for, then the product's own offer, then list.
      let unitPrice: number;
      let listPrice: number;
      if (variant) {
        unitPrice = variant.price;
        listPrice = variant.originalPrice ?? variant.price;
      } else {
        const tier = (tiersByProduct.get(product.id) ?? [])
          .filter((t) => line.qty >= t.minQty)
          .at(-1);
        unitPrice = tier?.unitPrice ?? product.offerPrice ?? product.price;
        listPrice = product.price;
      }

      return {
        slug: product.slug,
        name: product.name,
        qty: line.qty,
        listPrice: money(Math.max(listPrice, unitPrice)),
        unitPrice: money(unitPrice),
        lineTotal: money(unitPrice * line.qty),
        imageUrl: product.imageUrl,
        variantId: variant?.id ?? null,
        variantLabel: variant?.label ?? null,
        productId: product.id,
      };
    });
  }

  /**
   * Validates a promo code against the same rules the admin's own order form
   * applies: active, in date, under its usage limit.
   *
   * An invalid code is reported, not thrown — a shopper mistyping a coupon
   * should see "that code isn't valid", not lose their cart to a 400.
   */
  private async resolvePromo(
    tx: Db,
    tenantId: string,
    code: string,
    eligible: number,
  ): Promise<{ code: string; applied: boolean; amount: number; message: string }> {
    const wanted = code.trim().toUpperCase();
    const [promo] = await tx
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.tenantId, tenantId), sql`upper(${promoCodes.code}) = ${wanted}`))
      .limit(1);

    const reject = (message: string) => ({ code: wanted, applied: false, amount: 0, message });

    if (!promo) return reject("That promo code isn't valid.");
    if (promo.status !== "active") return reject("That promo code isn't active.");

    const today = new Date().toISOString().slice(0, 10);
    if (promo.validFrom && today < promo.validFrom) return reject("That promo code isn't active yet.");
    if (promo.validTo && today > promo.validTo) return reject("That promo code has expired.");
    if (promo.usageLimit > 0 && promo.used >= promo.usageLimit) {
      return reject("That promo code has been fully redeemed.");
    }

    const raw =
      promo.discountType === "percent"
        ? (eligible * promo.discountValue) / 100
        : promo.discountValue;
    const amount = money(Math.min(raw, eligible));

    return { code: promo.code, applied: true, amount, message: `${promo.code} applied.` };
  }

  /** The zone matching the district, else the catch-all, else nothing. */
  private async resolveDeliveryFee(tx: Db, tenantId: string, district?: string): Promise<number> {
    // No district chosen yet: the storefront shows delivery as "—" rather than
    // quoting a fee it would have to revise once an address is entered.
    if (!district) return 0;

    const [zone] = await tx
      .select({ fee: storefrontDeliveryZones.fee, district: storefrontDeliveryZones.district })
      .from(storefrontDeliveryZones)
      .where(
        and(
          eq(storefrontDeliveryZones.tenantId, tenantId),
          eq(storefrontDeliveryZones.active, true),
          or(eq(storefrontDeliveryZones.district, district), isNull(storefrontDeliveryZones.district)),
        ),
      )
      // An exact district match must win over the catch-all; nulls sort last.
      .orderBy(sql`${storefrontDeliveryZones.district} is null`, asc(storefrontDeliveryZones.sort))
      .limit(1);

    return zone?.fee ?? 0;
  }

  private async resolvePaymentMethod(tx: Db, tenantId: string, code: string) {
    const [method] = await tx
      .select()
      .from(storefrontPaymentMethods)
      .where(
        and(
          eq(storefrontPaymentMethods.tenantId, tenantId),
          eq(storefrontPaymentMethods.code, code),
          eq(storefrontPaymentMethods.active, true),
        ),
      )
      .limit(1);
    if (!method) throw new BadRequestException("That payment method isn't available.");
    return method;
  }

  /**
   * Sums the tenant's active tax rates.
   *
   * Region-specific and compound rates exist in the table but are not applied
   * here: doing that properly needs a jurisdiction resolved from the shipping
   * address, which this checkout does not model yet. Shops with no active rates
   * — including 365 — get zero, which is correct for them.
   */
  private async resolveTax(tx: Db, tenantId: string, taxable: number): Promise<number> {
    if (taxable <= 0) return 0;
    const rates = await tx
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(and(eq(taxRates.tenantId, tenantId), eq(taxRates.status, "active")));
    const total = rates.reduce((sum, r) => sum + r.rate, 0);
    return money((taxable * total) / 100);
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /**
   * Creates a customer-placed order, or creates nothing at all.
   *
   * The whole method body runs in one transaction on purpose. `reserveOrder`
   * throws a 409 when stock is short, and that throw takes the order row, its
   * items and the customer upsert with it — so there is no moment where an
   * order exists that the warehouse cannot fill. This is the same guard
   * `CrudService.create` applies to admin-placed orders, reused rather than
   * re-implemented.
   */
  async placeOrder(tenant: TenantDto, input: PlaceOrderInput) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      // Re-priced here, ignoring anything the client believed. The response of
      // /cart/price is a quote, not an input.
      const priced = await this.priceCart(tx, tenant, {
        lines: input.lines,
        district: input.shipping.district,
        paymentMethod: input.paymentMethod,
        promoCode: input.promoCode,
      });

      if (input.promoCode && !priced.promo?.applied) {
        throw new BadRequestException(priced.promo?.message ?? "That promo code isn't valid.");
      }

      const method = await this.resolvePaymentMethod(tx, tenant.id, input.paymentMethod);
      const customerId = await this.upsertCustomer(tx, tenant.id, input);
      const billing = input.billing ?? input.shipping;
      const publicToken = randomBytes(24).toString("base64url");

      const order = await withOrderCode(tx, tenant.id, async (code) => {
        const [row] = await tx
          .insert(orders)
          .values({
            tenantId: tenant.id,
            code,
            customerId,
            customerName: input.shipping.name,
            placedBy: "customer",
            deliveryStatus: "pending",
            // Nothing is collected here: cash-on-delivery is owed on arrival,
            // everything else is settled out of band and marked paid by an
            // admin. Recording it as anything but unpaid would be a lie.
            paymentStatus: "unpaid",
            paymentMethod: method.code,
            subtotal: priced.totals.subtotal,
            savings: priced.totals.savings,
            discount: priced.totals.discount,
            deliveryFee: priced.totals.delivery,
            paymentCharge: priced.totals.paymentCharge,
            total: priced.totals.total,
            promoCode: priced.promo?.applied ? priced.promo.code : null,
            area: input.shipping.area,
            shippingName: input.shipping.name,
            shippingPhone: input.shipping.phone,
            shippingAddress: input.shipping.address,
            shippingDistrict: input.shipping.district,
            billingName: billing.name,
            billingPhone: billing.phone,
            billingAddress: billing.address,
            notes: input.notes ?? null,
            publicToken,
          })
          .returning();
        return row;
      });

      await tx.insert(orderItems).values(
        priced.lines.map((line, sort) => ({
          tenantId: tenant.id,
          orderId: order.id,
          productId: line.productId,
          name: line.variantLabel ? `${line.name} — ${line.variantLabel}` : line.name,
          qty: line.qty,
          unitPrice: line.unitPrice,
          sort,
        })),
      );

      // Throws ConflictException with a per-line shortfall breakdown, taking
      // the whole transaction with it. That rollback is the oversell guard.
      await this.fulfilment.reserveOrder(tx, tenant.id, order.id, { actor: "storefront" });

      if (priced.promo?.applied) {
        await tx
          .update(promoCodes)
          .set({ used: sql`${promoCodes.used} + 1` })
          .where(and(eq(promoCodes.tenantId, tenant.id), eq(promoCodes.code, priced.promo.code)));
      }

      await this.bumpCustomerTotals(tx, tenant.id, customerId, priced.totals.total);

      return { code: order.code, token: publicToken };
    });
  }

  /**
   * Finds the shopper, or creates them.
   *
   * Matched on phone first: in this market it is the identifier people actually
   * have and reuse, and email is optional at checkout. Without this every
   * repeat customer would become a new row and the admin's customer list would
   * be a list of orders.
   */
  private async upsertCustomer(tx: Db, tenantId: string, input: PlaceOrderInput): Promise<string> {
    const phone = input.shipping.phone;
    const [existing] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          input.email
            ? or(eq(customers.phone, phone), eq(customers.email, input.email))!
            : eq(customers.phone, phone),
        ),
      )
      .limit(1);

    if (existing) return existing.id;

    const [created] = await tx
      .insert(customers)
      .values({
        tenantId,
        name: input.shipping.name,
        phone,
        email: input.email ?? null,
      })
      .returning({ id: customers.id });
    return created.id;
  }

  private async bumpCustomerTotals(tx: Db, tenantId: string, customerId: string, total: number) {
    await tx
      .update(customers)
      .set({
        orders: sql`${customers.orders} + 1`,
        totalSpent: sql`${customers.totalSpent} + ${total}`,
        updatedAt: new Date(),
      })
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * Reads back one order for the shopper who placed it.
   *
   * Gated on the token, never the code alone — ORD-1234 is guessable in four
   * digits and this response carries a name, a phone number and a home address.
   * A wrong token is the same 404 as a wrong code, so the endpoint cannot be
   * used to discover which codes exist.
   */
  async findOrder(tenant: TenantDto, code: string, token: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenant.id), eq(orders.code, code)))
        .limit(1);

      // Compared after the lookup so a missing order and a bad token cost the
      // same, and answer the same.
      if (!order || !order.publicToken || order.publicToken !== token) {
        throw new NotFoundException("Order not found");
      }

      const items = await tx
        .select({
          name: orderItems.name,
          qty: orderItems.qty,
          unitPrice: orderItems.unitPrice,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id))
        .orderBy(asc(orderItems.sort));

      return {
        code: order.code,
        placedAt: order.createdAt,
        deliveryStatus: order.deliveryStatus,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        promoCode: order.promoCode,
        notes: order.notes,
        totals: {
          subtotal: order.subtotal,
          savings: order.savings,
          discount: order.discount,
          delivery: order.deliveryFee,
          paymentCharge: order.paymentCharge,
          total: order.total,
        },
        shipping: {
          name: order.shippingName,
          phone: order.shippingPhone,
          address: order.shippingAddress,
          district: order.shippingDistrict,
          area: order.area,
        },
        billing: {
          name: order.billingName,
          phone: order.billingPhone,
          address: order.billingAddress,
        },
        items,
        currency: tenant.config.currency,
        currencySymbol: tenant.config.currencySymbol,
      };
    });
  }
}
