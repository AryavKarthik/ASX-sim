// Small shared pieces of the interface: icons, sparklines, info tips and number formatting.

import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Bar } from "../api";
import { formatPrice } from "../format";

// ---------- numbers ----------

export function money(value: string | number | null | undefined, signed = false): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const text = Math.abs(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  if (signed) return `${n > 0 ? "+" : n < 0 ? "−" : ""}${text}`;
  return n < 0 ? `−${text}` : text;
}

export function pct(value: number | null | undefined, signed = true, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = signed ? (value > 0 ? "+" : value < 0 ? "−" : "") : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function tone(value: string | number | null | undefined): "up" | "down" | "" {
  const n = Number(value ?? 0);
  return n > 0 ? "up" : n < 0 ? "down" : "";
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-AU");
}

/** "+1.20 (+2.15%)" coloured by direction. */
export function Change({ change, percent, price }: { change: number | null; percent: number | null; price?: number | null }) {
  if (percent == null) return <span className="muted">—</span>;
  const digits = price != null && price < 2 ? 3 : 2;
  const sign = percent > 0 ? "+" : percent < 0 ? "−" : "";
  return (
    <span className={`change ${tone(percent)}`}>
      {change != null && `${sign}${Math.abs(change).toFixed(digits)} `}({pct(percent)})
    </span>
  );
}

export function Price({ value }: { value: number | null }) {
  return <>{value == null ? "—" : formatPrice(value)}</>;
}

// ---------- info tips ----------

/** A small "i" that explains a term on hover or focus. */
export function Info({ text }: { text: string }) {
  return (
    <span className="info" tabIndex={0} role="img" aria-label={text} data-tip={text}>
      i
    </span>
  );
}

/** A small label. With a tip, the term gets a dotted underline and explains itself on hover. */
export function Label({ children, tip }: { children: ReactNode; tip?: string }) {
  if (!tip) return <span className="label">{children}</span>;
  return (
    <span className="label has-tip" tabIndex={0} data-tip={tip} aria-label={typeof children === "string" ? `${children}: ${tip}` : tip}>
      {children}
    </span>
  );
}

// ---------- motion ----------

/**
 * A class that briefly flashes green or red when a number goes up or down, as broker
 * screens do. Alternates between two identical animations so back-to-back moves re-trigger.
 */
export function useFlash(value: number | null | undefined): string {
  const previous = useRef(value);
  const count = useRef(0);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before == null || value == null || before === value) return;
    count.current += 1;
    setFlash(`${value > before ? "flash-up" : "flash-down"}-${count.current % 2}`);
    const timer = window.setTimeout(() => setFlash(""), 900);
    return () => window.clearTimeout(timer);
  }, [value]);
  return flash;
}

/** A price that flashes when it changes. */
export function FlashPrice({ value, className = "" }: { value: number | null; className?: string }) {
  const flash = useFlash(value);
  return (
    <span className={`flash-target ${flash} ${className}`}>
      <Price value={value} />
    </span>
  );
}

/** A shimmering placeholder shown while data loads. */
export function Skeleton({ width = "100%", height = 14, className = "" }: { width?: number | string; height?: number; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width, height }} aria-hidden />;
}

// ---------- sparkline ----------

/** A tiny line of the day's prices, green if it ended higher than it started. */
export function Sparkline({ bars, height = 32, className = "" }: { bars: Bar[]; height?: number; className?: string }) {
  const closes = bars.map((b) => b.close);
  if (closes.length < 2) return <div className={`sparkline empty ${className}`} style={{ height }} />;
  const width = 120;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const step = width / (closes.length - 1);
  const points = closes.map((c, i) => `${(i * step).toFixed(1)},${(height - 2 - ((c - min) / span) * (height - 4)).toFixed(1)}`);
  const rising = closes[closes.length - 1] >= closes[0];
  const colour = rising ? "var(--up)" : "var(--down)";
  return (
    <svg className={`sparkline ${className}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={`fade-${rising ? "up" : "down"}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.14" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={`url(#fade-${rising ? "up" : "down"})`} />
      <polyline points={points.join(" ")} fill="none" stroke={colour} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---------- logo ----------

/** The ASX-sim mark: three rising candlesticks on a blue tile (same drawing as favicon.svg). */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#2f6bff" />
      <g stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
        <line x1="9" y1="15" x2="9" y2="24" />
        <line x1="16" y1="10" x2="16" y2="22" />
        <line x1="23" y1="6" x2="23" y2="19" />
      </g>
      <g fill="#fff">
        <rect x="7" y="17" width="4" height="5" rx="1.2" />
        <rect x="14" y="12.5" width="4" height="7" rx="1.2" />
        <rect x="21" y="8" width="4" height="8.5" rx="1.2" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark: "ASX" in bold, "sim" lighter. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="logo-lockup">
      <LogoMark size={size} />
      <span className="wordmark">
        ASX<span>sim</span>
      </span>
    </span>
  );
}

// ---------- icons (outline, 24px grid, in the style of Heroicons) ----------

const PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z",
  watchlist: "M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .47.35l5.52.44c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.56l1.28 5.39a.56.56 0 0 1-.84.61l-4.73-2.89a.56.56 0 0 0-.59 0l-4.73 2.89a.56.56 0 0 1-.84-.61l1.28-5.39a.56.56 0 0 0-.18-.56l-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .47-.35L11.48 3.5Z",
  portfolio: "M20 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M3 12h18",
  coach: "M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.4-4 8-9 8a9.9 9.9 0 0 1-4.26-.95L3 20l1.4-3.72A7.5 7.5 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8Z",
  swing: "M3 17l6-6 4 4 8-8M15 7h6v6",
  replay: "M12 8v4l3 3M3.05 11a9 9 0 1 1 .5 4M3 4v5h5",
  search: "M21 21l-4.35-4.35M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z",
  settings: "M10.3 3.6c.4-1.5 2.6-1.5 3 0a1.5 1.5 0 0 0 2.3 1c1.3-.8 2.9.7 2.1 2.1a1.5 1.5 0 0 0 1 2.3c1.5.4 1.5 2.6 0 3a1.5 1.5 0 0 0-1 2.3c.8 1.3-.8 2.9-2.1 2.1a1.5 1.5 0 0 0-2.3 1c-.4 1.5-2.6 1.5-3 0a1.5 1.5 0 0 0-2.3-1c-1.3.8-2.9-.8-2.1-2.1a1.5 1.5 0 0 0-1-2.3c-1.5-.4-1.5-2.6 0-3a1.5 1.5 0 0 0 1-2.3c-.8-1.4.8-2.9 2.1-2.1a1.5 1.5 0 0 0 2.3-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  close: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  back: "M15 18l-6-6 6-6",
  star: "M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .47.35l5.52.44c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.56l1.28 5.39a.56.56 0 0 1-.84.61l-4.73-2.89a.56.56 0 0 0-.59 0l-4.73 2.89a.56.56 0 0 1-.84-.61l1.28-5.39a.56.56 0 0 0-.18-.56l-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .47-.35L11.48 3.5Z",
};

export function Icon({ name, size = 20, filled = false }: { name: keyof typeof PATHS | string; size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
