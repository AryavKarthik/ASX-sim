// Drawing tools on a Lightweight Charts price pane: placing, selecting, dragging, deleting
// and saving lines. The chart has no drawing tools of its own, so lines are painted by a
// "series primitive" (a plugin layer the chart redraws with every frame) and the mouse is
// handled here, on the chart's container.

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

import {
  type Drawing,
  type Hit,
  type Mapper,
  type Point,
  type Shape,
  type Tool,
  hitTest,
  interpolatedX,
  moved,
  parseDrawings,
  shapeOf,
  snapPrice,
} from "./geometry";

// Near-white: distinct from the candles and every indicator colour, and high contrast on the
// dark chart. Drawings are the user's own marks, so they read as ink rather than data.
const INK = "#e6ebf2";
const HANDLE_FILL = "#121923";
const STORAGE_PREFIX = "asxsim.drawings.v1.";

export type DrawingState = {
  tool: Tool | null;
  drafting: boolean; // the first point of a trend line or ray is placed
  count: number;
  selected: boolean;
};

type Draft = { a: Point; hover: Point };
type Drag = { hit: Hit; original: Drawing; startLogical: number; startPrice: number };

/** Paints the drawings. Holds no state of its own: it asks the controller every frame. */
class DrawingLayer implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private axisViews: ISeriesPrimitiveAxisView[] = [];
  private readonly views: IPrimitivePaneView[];

  constructor(private readonly owner: DrawingController) {
    this.views = [{ zOrder: () => "top", renderer: () => this.renderer() }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  redraw(): void {
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    // Price labels for horizontal lines, rebuilt when anything changes (a new array tells the
    // chart to re-lay out its axis labels).
    this.axisViews = this.owner.drawings.flatMap((d) => {
      if (d.kind !== "hline") return [];
      const y = this.owner.series.priceToCoordinate(d.price);
      if (y == null) return [];
      const text = this.owner.series.priceFormatter().format(d.price);
      return [{ coordinate: () => y, text: () => text, textColor: () => "#0b0f14", backColor: () => INK }];
    });
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private renderer(): IPrimitivePaneRenderer {
    const shapes = this.owner.shapes();
    const selected = this.owner.selected;
    const draft = this.owner.draftShape();
    return {
      draw: (target) =>
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
          const line = (x1: number, y1: number, x2: number, y2: number, width: number, dashed = false) => {
            ctx.beginPath();
            ctx.setLineDash(dashed ? [6 * hr, 4 * hr] : []);
            ctx.lineWidth = width * hr;
            ctx.strokeStyle = INK;
            ctx.moveTo(x1 * hr, y1 * vr);
            ctx.lineTo(x2 * hr, y2 * vr);
            ctx.stroke();
          };
          const handle = (x: number, y: number) => {
            ctx.beginPath();
            ctx.setLineDash([]);
            ctx.arc(x * hr, y * vr, 4.5 * hr, 0, Math.PI * 2);
            ctx.fillStyle = HANDLE_FILL;
            ctx.fill();
            ctx.lineWidth = 1.5 * hr;
            ctx.strokeStyle = INK;
            ctx.stroke();
          };
          ctx.save();
          for (const [id, s] of shapes) {
            const isSelected = id === selected;
            const width = isSelected ? 2.5 : 1.5;
            if (s.kind === "hline") {
              line(0, s.y, bitmapSize.width / hr, s.y, width);
              if (isSelected) handle(bitmapSize.width / hr / 2, s.y);
            } else {
              line(s.ax, s.ay, s.x2, s.y2, width);
              if (isSelected) {
                handle(s.ax, s.ay);
                handle(s.bx, s.by);
              }
            }
          }
          if (draft) {
            line(draft.ax, draft.ay, draft.bx, draft.by, 1.5, true);
            handle(draft.ax, draft.ay);
          }
          ctx.restore();
        }),
    };
  }
}

export class DrawingController {
  drawings: Drawing[] = [];
  selected: string | null = null;
  private tool: Tool | null = null;
  private draft: Draft | null = null;
  private drag: Drag | null = null;
  private scope: string | null = null;
  private swallowNext = false; // stop the chart seeing the mouse event we've just handled
  private readonly layer: DrawingLayer;
  private ids = 0;

  constructor(
    private readonly chart: IChartApi,
    readonly series: ISeriesApi<SeriesType>,
    private readonly container: HTMLElement,
    private readonly mapper: () => Mapper,
    private readonly onState: (state: DrawingState) => void,
  ) {
    this.layer = new DrawingLayer(this);
    series.attachPrimitive(this.layer);
    // Capture phase on the container runs before the chart's own handlers on its canvases,
    // so a click that places or grabs a line never also pans the chart.
    container.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    for (const kind of ["mousedown", "touchstart"] as const) container.addEventListener(kind, this.onSwallow, { capture: true });
    container.addEventListener("pointermove", this.onHover);
    container.addEventListener("pointerleave", this.onLeave);
    window.addEventListener("keydown", this.onKey);
    this.emit();
  }

  destroy(): void {
    this.container.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    for (const kind of ["mousedown", "touchstart"] as const) this.container.removeEventListener(kind, this.onSwallow, { capture: true });
    this.container.removeEventListener("pointermove", this.onHover);
    this.container.removeEventListener("pointerleave", this.onLeave);
    window.removeEventListener("keydown", this.onKey);
    this.endDrag();
    this.series.detachPrimitive(this.layer);
  }

  // ------------------------------------------------------------------ public actions

  /** Load the drawings saved for this chart (a stock, or a practice session). */
  setScope(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.drawings = scope ? load(scope) : [];
    this.selected = null;
    this.cancel();
  }

  setTool(tool: Tool | null): void {
    this.tool = this.tool === tool ? null : tool;
    this.draft = null;
    if (this.tool) this.selected = null;
    this.update();
  }

  deleteSelected(): void {
    if (!this.selected) return;
    this.drawings = this.drawings.filter((d) => d.id !== this.selected);
    this.selected = null;
    this.commit();
  }

  clear(): void {
    this.drawings = [];
    this.selected = null;
    this.commit();
  }

  /** The bars changed (new candle, timeframe, zoom): redraw. */
  refresh(): void {
    this.layer.redraw();
  }

  // ------------------------------------------------------------------ for the layer

  shapes(): Map<string, Shape> {
    const scales = this.scales();
    const mapper = this.mapper();
    const out = new Map<string, Shape>();
    for (const d of this.drawings) {
      const shape = shapeOf(d, mapper, scales);
      if (shape) out.set(d.id, shape);
    }
    return out;
  }

  draftShape(): { ax: number; ay: number; bx: number; by: number } | null {
    if (!this.draft) return null;
    const shape = shapeOf({ id: "draft", kind: "trend", a: this.draft.a, b: this.draft.hover }, this.mapper(), this.scales());
    return shape?.kind === "segment" ? shape : null;
  }

  // ------------------------------------------------------------------ internals

  private scales() {
    const timeScale = this.chart.timeScale();
    return {
      x: (logical: number) => interpolatedX((bar) => timeScale.logicalToCoordinate(bar as Logical), logical),
      y: (price: number) => this.series.priceToCoordinate(price),
      width: timeScale.width(),
    };
  }

  /** The chart point under the pointer, or null outside the price pane (axis, indicator panes). */
  private pointAt(event: PointerEvent, clamp = false): (Point & { logical: number; x: number; y: number }) | null {
    const box = this.container.getBoundingClientRect();
    let x = event.clientX - box.left;
    let y = event.clientY - box.top;
    const width = this.chart.timeScale().width();
    const height = this.chart.panes()[0]?.getHeight() ?? box.height;
    if (clamp) {
      x = Math.min(Math.max(x, 0), width);
      y = Math.min(Math.max(y, 0), height);
    } else if (x < 0 || y < 0 || x > width || y > height) {
      return null;
    }
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const price = this.series.coordinateToPrice(y);
    if (logical == null || price == null) return null;
    return { time: this.mapper().toTime(logical), price, logical, x, y };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const p = this.pointAt(event);
    if (!p) return;
    if (this.tool) {
      this.claim(event);
      const point = { time: p.time, price: p.price };
      if (this.tool === "hline") {
        this.add({ id: this.newId(), kind: "hline", price: snapPrice(p.price) });
      } else if (!this.draft) {
        this.draft = { a: point, hover: point };
        this.update();
      } else {
        this.add({ id: this.newId(), kind: this.tool, a: this.draft.a, b: point });
      }
      return;
    }
    const hit = hitTest(this.drawings, this.shapes(), p.x, p.y);
    if (!hit) {
      if (this.selected) {
        this.selected = null;
        this.update();
      }
      return; // let the chart pan as usual
    }
    this.claim(event);
    this.selected = hit.id;
    const original = this.drawings.find((d) => d.id === hit.id)!;
    this.drag = { hit, original, startLogical: p.logical, startPrice: p.price };
    window.addEventListener("pointermove", this.onDrag);
    window.addEventListener("pointerup", this.onDrop);
    this.update();
  };

  private claim(event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.swallowNext = true;
  }

  private onSwallow = (event: Event): void => {
    if (!this.swallowNext) return;
    event.stopPropagation();
    if (event.type === "mousedown") this.swallowNext = false;
  };

  private onDrag = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const p = this.pointAt(event, true);
    if (!p) return;
    const next = moved(
      drag.original,
      this.mapper(),
      p.logical - drag.startLogical,
      p.price - drag.startPrice,
      drag.hit.handle,
      { time: p.time, price: p.price },
    );
    this.drawings = this.drawings.map((d) => (d.id === next.id ? next : d));
    this.layer.redraw();
  };

  private onDrop = (): void => {
    this.endDrag();
    this.commit();
  };

  private endDrag(): void {
    this.drag = null;
    this.swallowNext = false;
    window.removeEventListener("pointermove", this.onDrag);
    window.removeEventListener("pointerup", this.onDrop);
  }

  private onHover = (event: PointerEvent): void => {
    if (this.drag) return;
    const p = this.pointAt(event);
    if (this.draft && p) {
      this.draft.hover = { time: p.time, price: p.price };
      this.layer.redraw();
    }
    const overLine = !this.tool && p != null && hitTest(this.drawings, this.shapes(), p.x, p.y) != null;
    this.container.classList.toggle("drawing-hover", overLine);
  };

  private onLeave = (): void => {
    this.container.classList.remove("drawing-hover");
  };

  private onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (event.key === "Escape") {
      if (this.tool || this.draft) this.cancel();
      else if (this.selected) {
        this.selected = null;
        this.update();
      }
    } else if ((event.key === "Delete" || event.key === "Backspace") && this.selected) {
      event.preventDefault();
      this.deleteSelected();
    }
  };

  private cancel(): void {
    this.tool = null;
    this.draft = null;
    this.update();
  }

  private add(drawing: Drawing): void {
    this.drawings = [...this.drawings, drawing];
    this.selected = drawing.id;
    this.tool = null; // one line per click of a tool, like most charting apps
    this.draft = null;
    this.commit();
  }

  private newId(): string {
    this.ids += 1;
    return `d${Date.now().toString(36)}${this.ids}`;
  }

  private commit(): void {
    if (this.scope) save(this.scope, this.drawings);
    this.update();
  }

  private update(): void {
    this.container.classList.toggle("drawing-tool", this.tool != null);
    this.layer.redraw();
    this.emit();
  }

  private emit(): void {
    this.onState({ tool: this.tool, drafting: this.draft != null, count: this.drawings.length, selected: this.selected != null });
  }
}

function load(scope: string): Drawing[] {
  try {
    return parseDrawings(JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + scope) ?? "[]"));
  } catch {
    return [];
  }
}

function save(scope: string, drawings: Drawing[]): void {
  try {
    if (drawings.length) window.localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(drawings));
    else window.localStorage.removeItem(STORAGE_PREFIX + scope);
  } catch {
    // Storage blocked: drawings still work, they just won't be remembered.
  }
}
