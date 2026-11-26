// Horizontal zoom for every price chart: thinner / wider / reset buttons, Ctrl + wheel around
// the pointer, and noticing when the time axis is dragged (which also stretches the candles).

import type { IChartApi } from "lightweight-charts";

import { canStep } from "./zoom";

/** Arrows pointing out (wider) or in (thinner), drawn on a 16px grid. */
function ZoomIcon({ direction }: { direction: 1 | -1 }) {
  const d = direction > 0 ? "M1 8h4M11 8h4M1 8l2-2M1 8l2 2M15 8l-2-2M15 8l-2 2M8 3v10" : "M1 8h5M10 8h5M6 8L4 6M6 8l-2 2M10 8l2-2M10 8l2 2M8 3v10";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function ZoomControls({ spacing, onStep, onReset }: { spacing: number; onStep: (direction: 1 | -1) => void; onReset: () => void }) {
  return (
    <div className="tf zoom" role="group" aria-label="Horizontal zoom">
      <button onClick={() => onStep(-1)} disabled={!canStep(spacing, -1)} title="Thinner candles: fit more time on the chart" aria-label="Zoom out (thinner candles)">
        <ZoomIcon direction={-1} />
      </button>
      <button onClick={() => onStep(1)} disabled={!canStep(spacing, 1)} title="Wider candles: see fewer, bigger candles" aria-label="Zoom in (wider candles)">
        <ZoomIcon direction={1} />
      </button>
      <button onClick={onReset} title="Reset the zoom. Tip: you can also drag the time axis under the chart left or right to stretch it, or hold Ctrl and scroll.">
        Reset
      </button>
    </div>
  );
}

/**
 * Ctrl + wheel (a trackpad pinch also sends this) zooms around the pointer, and a press on the
 * time axis counts as zooming too. `onZoomed` runs whenever you zoom; `onSpacing` reports the
 * current candle width after any change. Returns a function that removes it all.
 */
export function attachZoom(chart: IChartApi, container: HTMLElement, onZoomed: () => void, onSpacing: (spacing: number) => void): () => void {
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const box = container.getBoundingClientRect();
    const anchor = timeScale.coordinateToLogical(event.clientX - box.left) ?? (range.from + range.to) / 2;
    const factor = Math.exp(event.deltaY * 0.0025);
    const from = anchor - (anchor - range.from) * factor;
    const to = anchor + (range.to - anchor) * factor;
    if (to - from < 5) return; // don't zoom in past a handful of bars
    onZoomed();
    timeScale.setVisibleLogicalRange({ from, to });
  };
  const axisDrag = (event: PointerEvent) => {
    const box = container.getBoundingClientRect();
    if (event.clientY > box.bottom - chart.timeScale().height()) onZoomed();
  };
  const track = () => onSpacing(chart.timeScale().options().barSpacing);
  container.addEventListener("wheel", wheel, { passive: false });
  container.addEventListener("pointerdown", axisDrag);
  chart.timeScale().subscribeVisibleLogicalRangeChange(track);
  return () => {
    chart.timeScale().unsubscribeVisibleLogicalRangeChange(track);
    container.removeEventListener("pointerdown", axisDrag);
    container.removeEventListener("wheel", wheel);
  };
}
