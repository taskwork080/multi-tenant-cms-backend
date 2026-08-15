import { describe, expect, it } from "vitest";
import { isDisabled } from "./access.guard";

/**
 * The staff lifecycle gate.
 *
 * This is a regression test with a specific history: the first version of
 * AccessGuard rejected anything that was not `active`, which included
 * `invited` — and since nothing ever promoted an invited row, that locked out
 * every user who had been created through an invite, on a live database where
 * every staff row was still `invited`.
 */
describe("isDisabled", () => {
  it("blocks the two deliberately-disabled states", () => {
    expect(isDisabled("suspended")).toBe(true);
    expect(isDisabled("deactivated")).toBe(true);
  });

  it("does NOT block `invited` — holding a token means the invite was accepted", () => {
    // The promotion to `active` happens when AuthEventsService records the
    // sign-in, which arrives after this session's first requests. Rejecting
    // here would 403 the very session about to promote them.
    expect(isDisabled("invited")).toBe(false);
  });

  it("does not block an active member", () => {
    expect(isDisabled("active")).toBe(false);
  });

  it("does not block callers with no staff row (platform admins)", () => {
    expect(isDisabled(null)).toBe(false);
  });

  it("does not block an unrecognised state — fail open on states we did not define", () => {
    // A new lifecycle value should be added here deliberately, not lock people
    // out the moment someone writes it to the column.
    expect(isDisabled("archived")).toBe(false);
  });
});
