import { z } from "zod";

/**
 * How a purchase line was priced.
 *
 * Invoices quote both ways: "12 boxes @ 8.50" and "12 boxes — 100.00". Storing
 * only a unit cost loses the second, because a lot price rarely divides evenly:
 * 7 boxes for 100.00 is 14.285714… each, and recomputing the total from a
 * rounded 14.29 gives 100.03 — a figure that matches no invoice and no bank
 * statement. So both figures are stored, and `costMode` records which one the
 * buyer actually typed.
 */
export type CostMode = "unit" | "total";

/** The pricing half of a receipt line, as a client may send it. */
export const costInputSchema = {
  unitCost: z.number().nonnegative().optional(),
  lineTotal: z.number().nonnegative().optional(),
  costMode: z.enum(["unit", "total"]).optional(),
};

export interface CostFields {
  unitCost: number | null;
  lineTotal: number | null;
  costMode: CostMode;
}

/** Round to cents without the float drift of `toFixed` round-tripping. */
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** How a receipt's extra bills are spread across its lines. */
export type ChargeBasis = "value" | "qty";

export interface AllocatableLine {
  qty: number;
  /** What the supplier billed for this line; null when no price was recorded. */
  lineTotal: number | null;
}

/**
 * Spreads a receipt's extra bills — freight, duty, clearing — across its lines.
 *
 * Returns one figure per input line, in the same order, summing to EXACTLY
 * `chargesTotal`. That last part is the whole difficulty: shares are rounded to
 * cents, and three lines splitting 100.00 by thirds round to 33.33 each, which
 * is 99.99. A penny of a real bill would go missing from the books every time.
 * So the rounded shares are computed first and the remainder handed to the line
 * with the largest share, where it is proportionally least distorting.
 *
 * `value` is the default basis: duty and insurance scale with what the goods
 * are worth. `qty` is right for freight and handling, where a cheap bulky item
 * costs as much to move as a dear one. A `value` split falls back to `qty` when
 * no line carries a price at all — otherwise there is no ratio to divide by and
 * the charges would silently vanish.
 */
export function allocateCharges(
  lines: AllocatableLine[],
  chargesTotal: number,
  basis: ChargeBasis = "value",
): number[] {
  const out = lines.map(() => 0);
  const total = cents(chargesTotal);
  if (!lines.length || total <= 0) return out;

  const weightOf = (l: AllocatableLine, b: ChargeBasis) => (b === "qty" ? Math.max(0, l.qty) : Math.max(0, l.lineTotal ?? 0));

  // No line has a price, so there is nothing to weigh value against.
  let use: ChargeBasis = basis;
  if (use === "value" && lines.every((l) => weightOf(l, "value") === 0)) use = "qty";

  const weights = lines.map((l) => weightOf(l, use));
  const sum = weights.reduce((n, w) => n + w, 0);
  // Nothing to divide by on either basis — a receipt of zero-quantity lines.
  if (sum <= 0) return out;

  let assigned = 0;
  let largest = 0;
  weights.forEach((w, i) => {
    out[i] = cents((total * w) / sum);
    assigned = cents(assigned + out[i]);
    if (w > weights[largest]) largest = i;
  });

  // The rounding remainder, in whole cents, to the largest share.
  const drift = cents(total - assigned);
  if (drift !== 0) out[largest] = cents(out[largest] + drift);
  return out;
}

/** Landed figures for one line once its share of the charges is known. */
export function landedFor(qty: number, lineTotal: number | null, allocated: number) {
  if (lineTotal == null && allocated === 0) return { landedTotal: null, landedUnitCost: null };
  const landedTotal = cents((lineTotal ?? 0) + allocated);
  return { landedTotal, landedUnitCost: qty > 0 ? cents(landedTotal / qty) : null };
}

/**
 * Fills in whichever of unit cost / line total the caller didn't give.
 *
 * The mode decides which figure is authoritative, so the one the buyer typed is
 * stored exactly as typed and only the derived one carries rounding. A line
 * with no price at all stays priceless rather than becoming a 0.00 purchase —
 * "I didn't record what this cost" and "this was free" are different facts, and
 * averaging the second into a price history quietly corrupts it.
 */
export function normalizeCost(
  qty: number,
  input: { unitCost?: number | null; lineTotal?: number | null; costMode?: CostMode },
): CostFields {
  const mode: CostMode = input.costMode ?? (input.lineTotal != null && input.unitCost == null ? "total" : "unit");

  if (mode === "total") {
    const total = input.lineTotal;
    if (total == null) return { unitCost: null, lineTotal: null, costMode: "total" };
    // qty is validated positive upstream; the guard is here so a future caller
    // can't turn a zero-qty line into a division by zero.
    return { unitCost: qty > 0 ? cents(total / qty) : null, lineTotal: cents(total), costMode: "total" };
  }

  const unit = input.unitCost;
  if (unit == null) return { unitCost: null, lineTotal: null, costMode: "unit" };
  return { unitCost: cents(unit), lineTotal: cents(unit * qty), costMode: "unit" };
}
