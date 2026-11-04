import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { cx } from "../lib/cx";
import styles from "./charts.module.css";

// Charts are drawn in CSS pixels from the measured width, so strokes and
// dots keep their size instead of stretching with a viewBox.

export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const update = () => setWidth(Math.round(element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function niceCeil(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * base) {
      return step * base;
    }
  }
  return 10 * base;
}

/* ---------------------------------------------------------------- traffic */

export function TrafficStems(props: {
  up: number[];
  down: number[];
  capacity: number;
  height?: number;
  format: (value: number) => string;
  labels: { up: string; down: string; now: string; peak: string };
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = props.height ?? 220;
  const axis = 22;
  const plotHeight = height - axis;
  const mid = Math.round(plotHeight / 2);
  const reach = mid - 18;
  const capacity = props.capacity;
  const pad = 8;
  const step = width > 0 ? (width - pad * 2) / Math.max(capacity - 1, 1) : 0;
  const offset = capacity - props.up.length;
  const upMax = niceCeil(Math.max(...props.up, 1024));
  const downMax = niceCeil(Math.max(...props.down, 1024));
  const xAt = (index: number) => pad + (offset + index) * step;

  let peakIndex = -1;
  let peakValue = 0;
  props.up.forEach((value, index) => {
    const total = value + (props.down[index] ?? 0);
    if (total > peakValue) {
      peakValue = total;
      peakIndex = index;
    }
  });

  const hovered = hover !== null && hover >= 0 && hover < props.up.length ? hover : null;

  return (
    <div
      ref={ref}
      className={styles.traffic}
      style={{ height }}
      onPointerMove={(event) => {
        if (step <= 0 || props.up.length === 0) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const index = Math.round((event.clientX - rect.left - pad) / step) - offset;
        setHover(Math.max(0, Math.min(props.up.length - 1, index)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className={cx(styles.plot, "dot-grid")} style={{ height: plotHeight }} />
      {width > 0 && (
        <svg className={styles.svg} width={width} height={height} aria-hidden="true">
          <line x1={0} x2={width} y1={mid} y2={mid} className={styles.baseline} />
          {hovered !== null && (
            <line x1={xAt(hovered)} x2={xAt(hovered)} y1={4} y2={plotHeight - 4} className={styles.guide} />
          )}
          {props.up.map((value, index) => {
            const x = xAt(index);
            const upY = mid - (value / upMax) * reach;
            const downValue = props.down[index] ?? 0;
            const downY = mid + (downValue / downMax) * reach;
            return (
              <g key={index} className={hovered !== null && hovered !== index ? styles.dimmed : undefined}>
                {value > 0 && <line x1={x} x2={x} y1={mid} y2={upY} className={styles.stemUp} />}
                {downValue > 0 && <line x1={x} x2={x} y1={mid} y2={downY} className={styles.stemDown} />}
                <circle cx={x} cy={value > 0 ? upY : mid - 3} r={2.6} className={styles.dotUp} />
                <circle cx={x} cy={downValue > 0 ? downY : mid + 3} r={2.6} className={styles.dotDown} />
              </g>
            );
          })}
          {[60, 45, 30, 15, 0].map((secondsAgo) => {
            const x = pad + ((capacity - 1 - secondsAgo) / Math.max(capacity - 1, 1)) * (width - pad * 2);
            return (
              <text
                key={secondsAgo}
                x={Math.min(Math.max(x, pad), width - pad)}
                y={height - 4}
                className={styles.axisLabel}
                textAnchor={secondsAgo === 60 ? "start" : secondsAgo === 0 ? "end" : "middle"}
              >
                {secondsAgo === 0 ? props.labels.now : `-${secondsAgo}s`}
              </text>
            );
          })}
        </svg>
      )}
      {width > 0 && peakIndex >= 0 && peakValue > 0 && hovered === null && (
        <span
          className={styles.peak}
          style={{
            left: xAt(peakIndex),
            top: mid - ((props.up[peakIndex] ?? 0) / upMax) * reach - 30,
          }}
        >
          {props.labels.peak}
        </span>
      )}
      {width > 0 && (
        <>
          <span className={cx(styles.scale, styles.scaleUp)}>{props.format(upMax)}</span>
          <span className={cx(styles.scale, styles.scaleDown)} style={{ top: plotHeight - 18 }}>
            {props.format(downMax)}
          </span>
        </>
      )}
      {hovered !== null && width > 0 && (
        <div
          className="tooltip-card"
          style={{
            left: Math.min(Math.max(xAt(hovered) + 12, 0), width - 150),
            top: 8,
          }}
        >
          <div className="faint mono">
            {props.up.length - 1 - hovered === 0 ? props.labels.now : `-${props.up.length - 1 - hovered}s`}
          </div>
          <div className="legend-item">
            <span className="swatch up" />
            {props.labels.up}
            <span className="mono">{props.format(props.up[hovered] ?? 0)}</span>
          </div>
          <div className="legend-item">
            <span className="swatch down" />
            {props.labels.down}
            <span className="mono">{props.format(props.down[hovered] ?? 0)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ gauge */

function polar(cx: number, cy: number, radius: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function arcPath(cx: number, cy: number, radius: number, from: number, to: number) {
  const start = polar(cx, cy, radius, from);
  const end = polar(cx, cy, radius, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

const GAUGE_START = 135;
const GAUGE_SWEEP = 270;

export function RadialGauge(props: {
  value: number;
  max: number;
  tickLabels: string[];
  children?: ReactNode;
  size?: number;
}) {
  const size = props.size ?? 240;
  const center = size / 2;
  const radius = size / 2 - 34;
  const ratio = Math.max(0, Math.min(1, props.max > 0 ? props.value / props.max : 0));
  const end = GAUGE_START + GAUGE_SWEEP * ratio;
  const knob = polar(center, center, radius, end);
  const minorTicks = 54;
  return (
    <div className={styles.gauge} style={{ width: size, height: size * 0.88 }}>
      <svg width={size} height={size * 0.88} aria-hidden="true">
        {Array.from({ length: minorTicks + 1 }, (_, index) => {
          const angle = GAUGE_START + (GAUGE_SWEEP * index) / minorTicks;
          const major = index % (minorTicks / 4) === 0;
          const inner = polar(center, center, radius + 10, angle);
          const outer = polar(center, center, radius + (major ? 18 : 15), angle);
          const filled = index / minorTicks <= ratio;
          return (
            <line
              key={index}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              className={cx(styles.gaugeTick, filled && styles.gaugeTickFilled, major && styles.gaugeTickMajor)}
            />
          );
        })}
        {props.tickLabels.map((label, index) => {
          const angle = GAUGE_START + (GAUGE_SWEEP * index) / (props.tickLabels.length - 1);
          const point = polar(center, center, radius + 29, angle);
          return (
            <text key={index} x={point.x} y={point.y + 3} textAnchor="middle" className={styles.gaugeLabel}>
              {label}
            </text>
          );
        })}
        <path d={arcPath(center, center, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP)} className={styles.gaugeTrack} />
        {ratio > 0.002 && <path d={arcPath(center, center, radius, GAUGE_START, end)} className={styles.gaugeFill} />}
        <circle cx={knob.x} cy={knob.y} r={6.5} className={styles.gaugeKnob} />
      </svg>
      <div className={styles.gaugeCenter}>{props.children}</div>
    </div>
  );
}

/* ------------------------------------------------------------ smooth line */

function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) {
    return "";
  }
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[Math.max(index - 1, 0)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(index + 2, points.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

export function SmoothLine(props: { data: number[]; capacity: number; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = props.height ?? 120;
  const pad = 8;
  const data = props.data;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(max - min, Math.max(max * 0.1, 1));
  const low = min - span * 0.35;
  const high = max + span * 0.35;
  const step = width > 0 ? (width - pad * 2) / Math.max(props.capacity - 1, 1) : 0;
  const offset = props.capacity - data.length;
  const points = data.map((value, index) => ({
    x: pad + (offset + index) * step,
    y: pad + (1 - (value - low) / (high - low)) * (height - pad * 2),
  }));
  const last = points[points.length - 1];
  return (
    <div ref={ref} className={cx(styles.line, "dot-grid")} style={{ height }}>
      {width > 0 && points.length > 1 && (
        <svg width={width} height={height} aria-hidden="true">
          <path
            d={`${smoothPath(points)} L ${last.x} ${height} L ${points[0].x} ${height} Z`}
            className={styles.lineArea}
          />
          <path d={smoothPath(points)} className={styles.lineStroke} />
          <circle cx={last.x} cy={last.y} r={5} className={styles.lineKnob} />
        </svg>
      )}
    </div>
  );
}

/* -------------------------------------------------------- latency scale */

const TICK_TONES: Record<string, string | undefined> = {
  good: styles.tickGood,
  medium: styles.tickMedium,
  bad: styles.tickBad,
  neutral: styles.tickNeutral,
};

const HEAD_TONES: Record<string, string | undefined> = {
  good: styles.headGood,
  medium: styles.headMedium,
  bad: styles.headBad,
  neutral: styles.headNone,
};

export function LatencyScale(props: { delay: number; max: number; tone: string }) {
  const ticks = 48;
  const ratio = props.delay > 0 ? Math.min(1, props.delay / props.max) : 0;
  const steps = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(props.max * fraction));
  return (
    <div className={styles.scaleBar}>
      <div className={styles.scaleTicks}>
        {Array.from({ length: ticks }, (_, index) => (
          <span
            key={index}
            className={cx(styles.scaleTick, (index + 0.5) / ticks <= ratio && TICK_TONES[props.tone])}
          />
        ))}
      </div>
      <div className={styles.scaleLabels}>
        {steps.map((value, index) => (
          <span key={index}>{index === steps.length - 1 ? `${value} ms` : value}</span>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- node stems */

export interface StemNode {
  tag: string;
  label: string;
  delay: number;
  tone: "good" | "medium" | "bad" | "neutral";
}

export function NodeStems(props: {
  nodes: StemNode[];
  selected: string;
  selectable: boolean;
  onSelect: (tag: string) => void;
  height?: number;
}) {
  const height = props.height ?? 190;
  const maxDelay = Math.max(...props.nodes.map((node) => node.delay), 0);
  const scaleMax = niceCeil(Math.max(maxDelay, 300));
  const reach = height - 64;
  return (
    <div className={styles.stems}>
      <div className={styles.stemsTrack} style={{ height }}>
        {props.nodes.map((node) => {
          // Square-root scale: one slow node should not flatten the rest.
          const stem = node.delay > 0 ? Math.max(10, Math.sqrt(Math.min(node.delay, scaleMax) / scaleMax) * reach) : 0;
          const selected = node.tag === props.selected;
          return (
            <button
              type="button"
              key={node.tag}
              className={cx(styles.stemColumn, selected && styles.stemSelected, !props.selectable && styles.stemStatic)}
              title={node.delay > 0 ? `${node.tag} · ${node.delay} ms` : node.tag}
              aria-pressed={selected}
              onClick={() => props.onSelect(node.tag)}
            >
              <span className={styles.stemPlot}>
                {node.delay > 0 && (
                  <span className={styles.stemValue} style={{ bottom: stem + 12 }}>
                    {node.delay}
                  </span>
                )}
                <span className={styles.stemLine} style={{ height: stem }} />
                <span
                  className={cx(styles.stemHead, node.delay > 0 ? HEAD_TONES[node.tone] : styles.headNone)}
                  style={{ bottom: stem - 5 }}
                />
              </span>
              <span className={styles.stemLabel}>{node.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
