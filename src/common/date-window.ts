import { BadRequestException } from "@nestjs/common";

/** An explicit reporting window. `null` on either side means open-ended. */
export interface DateWindow {
  from: Date | null;
  to: Date | null;
}

/**
 * Longest span any aggregate will serve. This is not a nicety: the inventory
 * overview expands the window into one `generate_series` row per day, so an
 * unbounded `from` is a trivially reachable resource exhaustion.
 */
export const MAX_WINDOW_DAYS = 366;

const DAY_MS = 86_400_000;

/**
 * Parses the `?from=&to=` pair the aggregate endpoints accept.
 *
 * Takes either a full ISO instant — what the admin sends, already widened to
 * whole days by the client's `rangeFilter()` — or a bare `YYYY-MM-DD`, which is
 * pushed to end-of-day here so a hand-typed single-day window isn't empty.
 */
export function parseDateWindow(from?: string, to?: string): DateWindow {
  const parse = (raw: string | undefined, key: "from" | "to"): Date | null => {
    if (!raw) return null;
    const bareDay = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = new Date(bareDay ? (key === "to" ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`) : raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`"${key}" must be an ISO date`);
    return d;
  };

  const window: DateWindow = { from: parse(from, "from"), to: parse(to, "to") };
  if (window.from && window.to) {
    if (window.from > window.to) throw new BadRequestException(`"from" must not be after "to"`);
    if ((window.to.getTime() - window.from.getTime()) / DAY_MS > MAX_WINDOW_DAYS) {
      throw new BadRequestException(`Range must span at most ${MAX_WINDOW_DAYS} days`);
    }
  }
  return window;
}

/**
 * The comparison window for a period-over-period delta: the same-length span
 * immediately before `from`. An open-ended window has no meaningful
 * predecessor, so it returns nulls.
 *
 * For the preset case (`to === null`) this reproduces the old arithmetic
 * exactly — `end` is now, so `from - len` is `now - 2 * days`.
 */
export function previousWindow(w: DateWindow, now = new Date()): DateWindow {
  if (!w.from) return { from: null, to: null };
  const end = w.to ?? now;
  const len = end.getTime() - w.from.getTime();
  return { from: new Date(w.from.getTime() - len), to: w.from };
}
