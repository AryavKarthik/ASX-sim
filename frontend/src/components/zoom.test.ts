import { describe, expect, it } from "vitest";

import { MAX_BAR_SPACING, MIN_BAR_SPACING, ZOOM_STEP, canStep, steppedSpacing } from "./zoom";

describe("steppedSpacing", () => {
  it("makes candles wider or thinner by one step", () => {
    expect(steppedSpacing(8, 1)).toBeCloseTo(8 * ZOOM_STEP);
    expect(steppedSpacing(8, -1)).toBeCloseTo(8 / ZOOM_STEP);
  });

  it("undoes itself", () => {
    expect(steppedSpacing(steppedSpacing(8, 1), -1)).toBeCloseTo(8);
  });

  it("stays within the limits", () => {
    expect(steppedSpacing(MAX_BAR_SPACING - 1, 1)).toBe(MAX_BAR_SPACING);
    expect(steppedSpacing(MIN_BAR_SPACING + 0.1, -1)).toBe(MIN_BAR_SPACING);
  });
});

describe("canStep", () => {
  it("stops at the limits", () => {
    expect(canStep(MAX_BAR_SPACING, 1)).toBe(false);
    expect(canStep(MAX_BAR_SPACING, -1)).toBe(true);
    expect(canStep(MIN_BAR_SPACING, -1)).toBe(false);
    expect(canStep(MIN_BAR_SPACING, 1)).toBe(true);
  });
});
