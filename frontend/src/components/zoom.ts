// Horizontal zoom: how wide each candle is drawn, in pixels ("bar spacing").

export const MIN_BAR_SPACING = 1; // thinnest: about 1px per candle, a long stretch of history
export const MAX_BAR_SPACING = 60; // widest: a handful of fat candles
export const ZOOM_STEP = 1.35; // each click makes candles about a third wider or thinner

/** The bar spacing after one step wider (+1) or thinner (−1), kept within sensible limits. */
export function steppedSpacing(current: number, direction: 1 | -1): number {
  const next = direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP;
  return Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, next));
}

/** Whether another step in that direction would change anything. */
export function canStep(current: number, direction: 1 | -1): boolean {
  return direction > 0 ? current < MAX_BAR_SPACING - 1e-6 : current > MIN_BAR_SPACING + 1e-6;
}
