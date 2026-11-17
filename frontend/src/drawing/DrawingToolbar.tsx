import { useEffect, useState } from "react";

import type { DrawingController, DrawingState } from "./controller";
import type { Tool } from "./geometry";

const TOOLS: { tool: Tool; label: string; icon: string; help: string }[] = [
  {
    tool: "hline",
    label: "Line",
    icon: "—",
    help: "Horizontal line: mark a support or resistance level. Click once on the chart to place it.",
  },
  {
    tool: "trend",
    label: "Trend",
    icon: "╱",
    help: "Trend line: click two points, e.g. two lows of an uptrend.",
  },
  {
    tool: "ray",
    label: "Ray",
    icon: "↗",
    help: "Ray: a trend line that carries on to the right, to see where the trend points next. Click two points.",
  },
];

const HINTS: Record<Tool, [string, string]> = {
  hline: ["Click on the chart to place the line", ""],
  trend: ["Click the first point", "Now click the second point"],
  ray: ["Click the first point", "Now click a second point to set the direction"],
};

/** Buttons for the drawing tools, plus a hint while one is active. */
export function DrawingToolbar({ controller, state }: { controller: DrawingController | null; state: DrawingState }) {
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const hint = state.tool
    ? `${HINTS[state.tool][state.drafting ? 1 : 0]} · Esc to cancel`
    : state.selected
      ? "Drag to move · drag an end to adjust · Delete to remove"
      : null;

  return (
    <div className="draw-tools" role="group" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          className={state.tool === t.tool ? "active" : ""}
          aria-pressed={state.tool === t.tool}
          onClick={() => controller?.setTool(t.tool)}
          title={t.help}
        >
          <span aria-hidden>{t.icon}</span> {t.label}
        </button>
      ))}
      {state.selected && (
        <button onClick={() => controller?.deleteSelected()} title="Delete the selected drawing (or press Delete)">
          Delete
        </button>
      )}
      {state.count > 0 && !state.selected && (
        <button
          className={confirmClear ? "danger" : ""}
          onClick={() => {
            if (confirmClear) {
              controller?.clear();
              setConfirmClear(false);
            } else {
              setConfirmClear(true);
            }
          }}
          title="Remove every drawing on this chart"
        >
          {confirmClear ? `Remove all ${state.count}?` : "Clear"}
        </button>
      )}
      {hint && <span className="draw-hint muted">{hint}</span>}
    </div>
  );
}
