import { beforeAll, describe, expect, it } from "vitest";
import { GET, POST, PATCH } from "./support/http";
import { as, requireRoster, type Roster } from "./support/accounts";
import { levelAt, movements, requireFixture, totalOnHand, type TenantFixture } from "./support/fixtures";
import { clearedDefect } from "./support/known-defect";
import { currentRunId } from "./support/runid";
import type { Actor } from "./support/http";

/**
 * Stock ledger invariants, driven through the real document endpoints.
 *
 * The tests in this file run in a FIXED SEQUENCE against one fixture SKU, and
 * each asserts absolute quantities rather than deltas. That is deliberate: a
 * delta-based test passes just as happily when two bugs cancel out, and the
 * whole point of a ledger is that the absolute number is defensible.
 *
 * The invariant under test throughout is conservation: stock is created only by
 * a receipt, destroyed only by a count shortage, and a transfer moves it
 * without ever making it exist in two places — while a transfer is in transit
 * the units are on nobody's on-hand, and that gap is the correct answer, not a
 * rounding error.
 */

let roster: Roster;
let volt: TenantFixture;
let runId: string;
let actor: Actor;

const SLUG = "volt";

beforeAll(() => {
  roster = requireRoster();
  volt = requireFixture(SLUG);
  runId = currentRunId();
  actor = as(roster, "full-volt");
});

const RECEIVED = 100;
const MOVED = 30;
const COUNTED = 65;

/** Filled in by the receive test and read by the idempotency test. */
let receiptId = "";
let transferId = "";

describe("receiving", () => {
  it("starts from an untouched fixture SKU", async () => {
    // buildFixture stops short of any movement precisely so this is provable.
    // If it is not zero, an earlier run's teardown failed and every absolute
    // assertion below would be measuring someone else's stock.
    expect(await totalOnHand(actor, SLUG, volt.sku.id)).toBe(0);
  });

  it("confirming a receipt raises on-hand and writes one receive movement", async () => {
    const r = await POST(`/api/${SLUG}/inbound-receipts/new`, {
      as: actor,
      body: {
        warehouseId: volt.warehouseA.id,
        supplierName: `QA Supplier ${runId}`,
        confirm: true,
        items: [{ skuId: volt.sku.id, qty: RECEIVED }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.receipt.status).toBe("received");
    receiptId = r.body.receipt.id;

    const a = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    expect(a.onHand).toBe(RECEIVED);
    expect(a.reserved).toBe(0);
    expect(a.incoming).toBe(0);

    const ledger = await movements(actor, SLUG, volt.sku.id);
    const receives = ledger.filter((m) => m.kind === "receive");
    expect(receives).toHaveLength(1);
    expect(Number(receives[0].qty)).toBe(RECEIVED);
    expect(receives[0].refType).toBe("receipt");
    // The movement must point back at the document, or the ledger cannot be
    // reconciled against the paperwork it claims to record.
    expect(receives[0].refId).toBe(receiptId);
  });

  it("creates the destination level row only as a side effect of the movement", async () => {
    // inventory_levels has a single writer (InventoryService.lockLevel). Before
    // any movement touched warehouse B there must be no row for it at all —
    // levelAt() synthesises the zero, so the proof is that the LIST does not
    // carry it.
    const listed = await GET(
      `/api/${SLUG}/inventory-levels?skuId=${volt.sku.id}&warehouseId=${volt.warehouseB.id}`,
      { as: actor },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.data ?? []).toHaveLength(0);
  });

  it("re-confirming an already received note is idempotent", async () => {
    const again = await POST(`/api/${SLUG}/inbound-receipts/${receiptId}/confirm`, { as: actor });
    expect(again.status).toBe(201);
    expect(again.body.receipt.status).toBe("received");

    // The real assertion: no second movement, no doubled stock.
    const a = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    expect(a.onHand).toBe(RECEIVED);
    expect((await movements(actor, SLUG, volt.sku.id)).filter((m) => m.kind === "receive")).toHaveLength(1);
  });
});

describe("transferring", () => {
  it("dispatch removes stock from the source without landing it at the destination", async () => {
    const created = await POST(`/api/${SLUG}/stock-transfers/new`, {
      as: actor,
      body: {
        fromWarehouseId: volt.warehouseA.id,
        toWarehouseId: volt.warehouseB.id,
        note: `QA transfer ${runId}`,
        items: [{ skuId: volt.sku.id, qty: MOVED }],
      },
    });
    expect(created.status).toBe(201);
    transferId = created.body.id;

    // A draft moves nothing.
    expect((await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id)).onHand).toBe(RECEIVED);

    const sent = await POST(`/api/${SLUG}/stock-transfers/${transferId}/dispatch`, {
      as: actor,
      body: { carrier: `QA Carrier ${runId}` },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe("in_transit");

    const a = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    const b = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseB.id);
    expect(a.onHand).toBe(RECEIVED - MOVED);
    expect(b.onHand).toBe(0);
    expect(b.incoming).toBe(MOVED);

    // Conservation while in transit: the units are on NOBODY's on-hand. A total
    // of 100 here would mean the transfer had duplicated stock.
    expect(await totalOnHand(actor, SLUG, volt.sku.id)).toBe(RECEIVED - MOVED);
  });

  it("receiving the transfer lands it and clears incoming", async () => {
    const got = await POST(`/api/${SLUG}/stock-transfers/${transferId}/receive`, { as: actor, body: {} });
    expect(got.status).toBe(201);
    expect(got.body.status).toBe("received");

    const a = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    const b = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseB.id);
    expect(a.onHand).toBe(RECEIVED - MOVED);
    expect(b.onHand).toBe(MOVED);
    expect(b.incoming).toBe(0);

    // Conservation restored: nothing was created or destroyed by moving it.
    expect(await totalOnHand(actor, SLUG, volt.sku.id)).toBe(RECEIVED);

    const ledger = await movements(actor, SLUG, volt.sku.id);
    expect(ledger.filter((m) => m.kind === "transfer_out")).toHaveLength(1);
    expect(ledger.filter((m) => m.kind === "transfer_in")).toHaveLength(1);
    expect(Number(ledger.find((m) => m.kind === "transfer_out")!.qty)).toBe(-MOVED);
    expect(Number(ledger.find((m) => m.kind === "transfer_in")!.qty)).toBe(MOVED);
  });

  it("refuses to dispatch more than the source holds, and changes nothing when it does", async () => {
    const before = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    const overdraw = before.onHand + 1_000;

    const created = await POST(`/api/${SLUG}/stock-transfers/new`, {
      as: actor,
      body: {
        fromWarehouseId: volt.warehouseA.id,
        toWarehouseId: volt.warehouseB.id,
        note: `QA overdraw ${runId}`,
        items: [{ skuId: volt.sku.id, qty: overdraw }],
      },
    });
    expect(created.status).toBe(201); // drafting an impossible transfer is allowed

    const sent = await POST(`/api/${SLUG}/stock-transfers/${created.body.id}/dispatch`, { as: actor, body: {} });
    expect(sent.ok).toBe(false);

    // The whole dispatch must roll back — a partial dispatch would leave the
    // source drawn down against a transfer that never left.
    const after = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    expect(after.onHand).toBe(before.onHand);
    expect((await levelAt(actor, SLUG, volt.sku.id, volt.warehouseB.id)).incoming).toBe(0);

    clearedDefect(
      {
        id: "QA-INV-01",
        title: "A stock transfer cannot dispatch stock the source does not hold",
        severity: "critical",
        expected: "Dispatching more than on-hand is rejected and leaves both levels untouched.",
        source: "inventory.service.ts applyMovement -> inventory_levels non-negative constraint",
      },
      `Dispatching ${overdraw} against ${before.onHand} on hand answered ${sent.status}; levels unchanged.`,
    );
  });
});

describe("counting", () => {
  it("posting a count reconciles on-hand to what was physically found", async () => {
    const opened = await POST(`/api/${SLUG}/cycle-counts/new`, {
      as: actor,
      body: {
        warehouseId: volt.warehouseA.id,
        scope: "manual",
        countedBy: `QA Counter ${runId}`,
        skuIds: [volt.sku.id],
      },
    });
    expect(opened.status).toBe(201);
    const countId = opened.body.id;

    const sheet = await GET(`/api/${SLUG}/cycle-counts/${countId}`, { as: actor });
    const items = (sheet.body.data ?? sheet.body).items as any[];
    expect(items).toHaveLength(1);
    // The sheet snapshots expected quantity at open time.
    expect(items[0].expectedQty).toBe(RECEIVED - MOVED);

    const saved = await PATCH(`/api/${SLUG}/cycle-counts/${countId}/lines`, {
      as: actor,
      body: { lines: [{ itemId: items[0].id, countedQty: COUNTED }] },
    });
    expect(saved.status).toBe(200);

    const posted = await POST(`/api/${SLUG}/cycle-counts/${countId}/post`, {
      as: actor,
      body: { note: `QA count ${runId}` },
    });
    expect(posted.status).toBe(201);
    expect(posted.body.adjustments).toBe(1);
    expect(posted.body.count.status).toBe("posted");

    const a = await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id);
    expect(a.onHand).toBe(COUNTED);

    // The shortage is recorded as a movement, not silently absorbed: a count is
    // the only way stock legitimately disappears, so it must leave a trace.
    const counts = (await movements(actor, SLUG, volt.sku.id)).filter((m) => m.kind === "count");
    expect(counts).toHaveLength(1);
    expect(Number(counts[0].qty)).toBe(COUNTED - (RECEIVED - MOVED));
    expect(counts[0].reason).toBe("count_shortage");
  });

  it("refuses to post a sheet where nothing was counted", async () => {
    // "We did not get to it" must never be read as "we found zero" — that
    // reading would wipe real stock on every partially-completed stock take.
    const opened = await POST(`/api/${SLUG}/cycle-counts/new`, {
      as: actor,
      body: { warehouseId: volt.warehouseA.id, scope: "manual", skuIds: [volt.sku.id] },
    });
    expect(opened.status).toBe(201);

    const posted = await POST(`/api/${SLUG}/cycle-counts/${opened.body.id}/post`, { as: actor, body: {} });
    expect(posted.status).toBe(409);
    expect(String(posted.body.message)).toMatch(/no lines have been counted/i);

    // And nothing moved.
    expect((await levelAt(actor, SLUG, volt.sku.id, volt.warehouseA.id)).onHand).toBe(COUNTED);

    clearedDefect(
      {
        id: "QA-INV-02",
        title: "An uncounted line is not treated as a count of zero",
        severity: "critical",
        expected: "Posting a sheet with no counted lines is refused rather than zeroing the stock.",
        source: "counts.controller.ts post() — items.filter(i => i.countedQty !== null)",
      },
      `Posting an uncounted sheet answered 409 and left on-hand at ${COUNTED}.`,
    );
  });
});

describe("ledger totals", () => {
  it("reconciles final on-hand against the sum of every movement", async () => {
    // The closing argument: on-hand is not an independently maintained number,
    // it is the sum of the ledger. If these two ever disagree the levels table
    // has a second writer and every stock figure in the product is guesswork.
    const ledger = await movements(actor, SLUG, volt.sku.id);
    const summed = ledger.reduce((n, m) => n + Number(m.qty), 0);
    const onHand = await totalOnHand(actor, SLUG, volt.sku.id);

    expect(summed).toBe(onHand);
    expect(onHand).toBe(COUNTED + MOVED);
  });
});
