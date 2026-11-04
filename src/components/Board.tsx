import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import { Icon, type IconName } from "./Icon";

// Ledger primitives. Styles live in src/styles/ledger.css.

export function Board(props: { className?: string; children: ReactNode }) {
  return <div className={cx("board", props.className)}>{props.children}</div>;
}

export type PanelSpan = 3 | 4 | 5 | 6 | 7 | 8 | 12;

export function Panel(props: {
  span?: PanelSpan;
  className?: string;
  flush?: boolean;
  children: ReactNode;
}) {
  const span = props.span ?? 12;
  return (
    <section className={cx("panel", span !== 12 && `span-${span}`, props.flush && "flush", props.className)}>
      {props.children}
    </section>
  );
}

export function IconTile(props: { icon: IconName; tone?: "accent" | "mark"; small?: boolean }) {
  return (
    <span className={cx("icon-tile", props.tone, props.small && "small")}>
      <Icon name={props.icon} size={props.small ? 14 : 17} />
    </span>
  );
}

export function PanelHead(props: {
  icon?: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("panel-head", props.className)}>
      {props.icon && <IconTile icon={props.icon} />}
      <div className="panel-head-text">
        <span className="panel-title">{props.title}</span>
        {props.subtitle != null && <span className="panel-subtitle">{props.subtitle}</span>}
      </div>
      {props.actions != null && <div className="panel-actions">{props.actions}</div>}
    </header>
  );
}

export function Metric(props: {
  value: ReactNode;
  unit?: ReactNode;
  size?: "medium" | "large";
  className?: string;
}) {
  return (
    <span className={cx("metric", props.size, props.className)}>
      {props.value}
      {props.unit != null && <span className="metric-unit">{props.unit}</span>}
    </span>
  );
}

export function Tabs<T extends string>(props: {
  options: { value: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("tabs", props.className)} role="tablist">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === props.value}
          className={cx("tab", option.value === props.value && "active")}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="tab-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>(props: {
  options: { value: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="legend" role="radiogroup">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === props.value}
          className={cx("chip", option.value === props.value && "active")}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="chip-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SectionHead(props: { title: ReactNode; detail?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-head">
      <span className="section-title">{props.title}</span>
      {props.detail != null && <span className="faint mono">{props.detail}</span>}
      {props.actions != null && <div className="actions">{props.actions}</div>}
    </div>
  );
}

export function Meter(props: { value: number; tone?: "accent" | "warn"; label?: string }) {
  const percent = Math.max(0, Math.min(1, Number.isFinite(props.value) ? props.value : 0)) * 100;
  return (
    <div
      className={cx("meter", props.tone)}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

// The brand mark: two hops joined by a route, the origin in signal colour.
export function BrandMark(props: { size?: number }) {
  const size = props.size ?? 34;
  return (
    <span className="icon-tile" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path
          d="M8.4 15.6c3.6-.6 3.2-6.4 7.2-7.4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="6" cy="17.4" r="2.8" fill="var(--accent)" />
        <circle cx="18.2" cy="6.8" r="2.6" stroke="currentColor" strokeWidth="2" />
      </svg>
    </span>
  );
}
