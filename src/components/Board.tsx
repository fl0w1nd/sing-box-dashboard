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

// The sing-box mark: the official box, drawn flat so it stays crisp at
// sidebar sizes (same geometry as public/favicon.svg).
export function BrandMark(props: { size?: number }) {
  const size = props.size ?? 34;
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="242 252 540 570" aria-hidden="true">
      <path d="M512 262 754.5 402 512 542 269.5 402Z" fill="#42555F" />
      <path d="M269.5 402 512 542 512 812 269.5 672Z" fill="#232F37" />
      <path d="M512 542 754.5 402 754.5 672 512 812Z" fill="#34444F" />
      <path d="M390.75 472 633.25 332" stroke="#141E24" strokeWidth="4" fill="none" />
      <path d="M512 262 754.5 402" stroke="#66808D" strokeWidth="2.5" fill="none" />
      <path d="M512 262 269.5 402" stroke="#5A737F" strokeWidth="2.5" fill="none" />
      <path d="M512 542 512 812" stroke="#445963" strokeWidth="2" fill="none" />
      <path d="M356.8 351.6 390.75 332 633.25 472 599.3 491.6Z" fill="#99AAB5" />
      <path d="M390.75 332 424.7 312.4 667.2 452.4 633.25 472Z" fill="#E1E8ED" />
      <path d="M599.3 491.6 633.25 472 633.25 592 599.3 611.6Z" fill="#8296A1" />
      <path d="M633.25 472 667.2 452.4 667.2 572.4 633.25 592Z" fill="#CCD6DD" />
    </svg>
  );
}
