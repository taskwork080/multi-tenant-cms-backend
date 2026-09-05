import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "./support/http";
import { as, requireRoster, type Roster } from "./support/accounts";
import { clearedDefect } from "./support/known-defect";
import { currentRunId } from "./support/runid";

/**
 * Rate limiting.
 *
 * The target is deliberately NOT the global 300/min ceiling. Tripping that one
 * would need 300+ requests, would cost a minute of the suite's own budget, and
 * would leave every later file — including teardown — talking to a server that
 * is 429ing it. The interesting limit is the per-handler one anyway: a
 * `@Throttle` on a route is only worth having if it is tracked SEPARATELY from
 * the global bucket, and that separation is what these tests prove.
 *
 * The chosen route is the public order-lookup: 30/min, a pure read, and on a
 * tenant without the storefront module it answers a uniform "Store
 * unavailable" 404 before touching a single row. So the flood below writes
 * nothing and reads nothing that exists.
 *
 * Every request here passes `noRetry` — the suite's client normally waits out a
 * 429 and retries once, which is exactly the behaviour under test.
 */

const BURST = 40;
/** The @Throttle on GET /api/public/storefront/:tenant/orders/:code. */
const HANDLER_LIMIT = 30;

let roster: Roster;
let runId: string;
let path: string;

beforeAll(() => {
  roster = requireRoster();
  runId = currentRunId();
  // volt has no `storefront` entitlement, so this 404s at requireLiveTenant.
  path = `/api/public/storefront/volt/orders/QA-NONE-${runId}?token=qa`;
});

describe("per-handler rate limiting", () => {
  const statuses: number[] = [];
  let firstLimited = -1;
  let retryAfter: string | null = null;

  it("starts refusing once the handler's own limit is reached", async () => {
    // Sequential, not parallel: the assertion is about the COUNT at which the
    // limiter engages, and concurrent requests would race the counter.
    for (let i = 0; i < BURST; i++) {
      const r = await GET(path, { noRetry: true });
      statuses.push(r.status);
      if (r.status === 429 && firstLimited === -1) {
        firstLimited = i + 1;
        retryAfter = r.headers.get("retry-after");
      }
    }

    expect(statuses).toContain(429);
    expect(firstLimited).toBeGreaterThan(0);

    // The limiter must engage at the handler's own limit, not the global 300.
    // Allowing one over covers the boundary being counted inclusively.
    expect(firstLimited).toBeLessThanOrEqual(HANDLER_LIMIT + 1);
  });

  it("answers the pre-limit requests uniformly", async () => {
    // Everything before the limit is the same "Store unavailable" 404. If some
    // were 404 and others 403, the endpoint would be leaking whether a slug
    // exists — which is the reason it 404s uniformly in the first place.
    const preLimit = statuses.slice(0, firstLimited - 1);
    expect(preLimit.length).toBeGreaterThan(0);
    expect(new Set(preLimit)).toEqual(new Set([404]));
  });

  it("tells the caller when to come back", async () => {
    // Without Retry-After a client can only guess, and guessing clients
    // hammer. The suite's own http.ts reads this header for exactly that reason.
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  it("does not spill over onto other routes", async () => {
    // The load-bearing assertion: exhausting one handler's budget must not
    // lock the caller out of the rest of the API. If ThrottlerGuard tracked by
    // IP alone, a bot hammering the public storefront would take every
    // authenticated admin session down with it.
    const r = await GET("/api/volt/warehouses?pageSize=1", { as: as(roster, "full-volt"), noRetry: true });
    expect(r.status).toBe(200);

    const health = await GET("/health", { noRetry: true });
    expect(health.status).toBe(200);

    clearedDefect(
      {
        id: "QA-RATE-01",
        title: "A per-handler @Throttle is tracked separately from the global ceiling",
        severity: "high",
        expected:
          "Exhausting one route's rate limit must not 429 unrelated routes or other callers' sessions.",
        source: "auth.module.ts APP_GUARD ThrottlerGuard; @Throttle on public-checkout.controller.ts",
      },
      `Public order-lookup 429'd at request ${firstLimited}/${BURST} (limit ${HANDLER_LIMIT}); an authenticated read and /health both still answered 200.`,
    );
  });
});
