import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators";
import { cartPriceSchema, orderLookupSchema, placeOrderSchema } from "./checkout.schemas";
import { PublicCheckoutService } from "./public-checkout.service";
import { StorefrontService } from "./storefront.service";

/**
 * Checkout for anonymous shoppers.
 *
 * Same three deliberate properties as PublicStorefrontController — `@Public()`,
 * no TenantGuard, explicit DTOs — plus two more that only matter once money is
 * involved:
 *
 *  - **Tighter rate limits than the read API.** These routes write, hit
 *    inventory and take locks; the 60/min read ceiling is far too generous for
 *    something that can create rows. There is no token to attribute abuse to,
 *    only an IP.
 *  - **No prices in, ever.** The request bodies have no price fields at all
 *    (see checkout.schemas.ts). Every figure is resolved server-side from the
 *    catalogue, so `/cart/price` is a quote the client displays and `POST
 *    /orders` re-derives independently rather than trusting it.
 *
 * Registered before CrudModule for the same reason as its sibling:
 * /api/public/storefront/... would otherwise match /api/:tenant/:resource with
 * tenant="public".
 */
@ApiTags("storefront-public")
@Public()
@Controller("api/public/storefront")
export class PublicCheckoutController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly checkout: PublicCheckoutService,
  ) {}

  @Post(":tenant/cart/price")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({
    summary: "Price a cart",
    description:
      "Resolves slugs and quantities into money: variant and tier pricing, promo code, delivery " +
      "zone, tax and payment surcharge. The request carries no prices — any the client sends are " +
      "ignored. An invalid promo code is reported in the response rather than rejected.",
  })
  async price(@Param("tenant") tenantSlug: string, @Body() body: unknown) {
    const tenant = await this.storefront.requireLiveTenant(tenantSlug);
    const input = cartPriceSchema.parse(body);
    return this.checkout.quoteCart(tenant, input);
  }

  @Post(":tenant/orders")
  // Much tighter: this one creates rows and holds stock. Ten a minute is more
  // than any human checks out and far less than a script needs to be useful.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({
    summary: "Place an order",
    description:
      "Creates the customer, order and its items and reserves stock in one transaction. Answers " +
      "409 with a per-line shortfall breakdown when stock is short — and in that case no order " +
      "row is created. Returns the order code plus an opaque token for reading it back.",
  })
  async place(@Param("tenant") tenantSlug: string, @Body() body: unknown) {
    const tenant = await this.storefront.requireLiveTenant(tenantSlug);
    const input = placeOrderSchema.parse(body);
    return this.checkout.placeOrder(tenant, input);
  }

  @Get(":tenant/orders/:code")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiParam({ name: "code", description: "Order code, e.g. ORD-1004" })
  @ApiQuery({ name: "token", description: "The token returned when the order was placed" })
  @ApiOperation({
    summary: "Read one order back",
    description:
      "Requires the token issued at placement: the code alone is guessable and this response " +
      "carries a name, phone number and address. A wrong token is the same 404 as a wrong code.",
  })
  async lookup(
    @Param("tenant") tenantSlug: string,
    @Param("code") code: string,
    @Query() query: unknown,
  ) {
    const tenant = await this.storefront.requireLiveTenant(tenantSlug);
    const { token } = orderLookupSchema.parse(query);
    return this.checkout.findOrder(tenant, code, token);
  }
}
