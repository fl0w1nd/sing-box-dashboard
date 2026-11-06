import { useEffect, useMemo, useRef, useState } from "react";

import {
  formatBytes,
  formatDurationMs,
  formatMemoryBytes,
  formatRelativeTime,
  inboundDisplayType,
  proxyDisplayType,
  splitNodeTag,
  urlTestDelayTone,
} from "../api/format";
import { STATUS_HISTORY_LENGTH } from "../api/daemon";
import { useStream } from "../api/stream";
import { useExtension } from "../app/capabilities";
import { navigate, useApi, useIsMobile, useNow } from "../app/context";
import { showError } from "../app/errorStore";
import { usePendingValue, useUnaryOnce } from "../app/hooks";
import { useI18n, type MessageKey } from "../app/i18n";
import { useDnsStats } from "../app/useDnsStats";
import { IconTile, Meter } from "../components/Board";
import { useElementWidth } from "../components/charts";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamBanner } from "../components/StreamBanner";
import { Topology, useTopologyLabel } from "../components/Topology";
import {
  Badge,
  Button,
  DataLine,
  DetailSection,
  DetailShell,
  Dialog,
  EmptyState,
  Spinner,
  type BadgeTone,
} from "../components/ui";
import { ServiceStatus_Type, type Group } from "../gen/daemon/started_service_pb";
import { cx } from "../lib/cx";
import {
  TOPOLOGY_COLUMNS,
  buildTopology,
  connectionsThrough,
  hostOf,
  nodeRate,
  processName,
  type TopologyColumn,
  type TopologyModel,
  type TopologyNode,
} from "../lib/topology";
import styles from "./OverviewView.module.css";

export function OverviewView() {
  const api = useApi();
  const { t } = useI18n();
  const serviceStatus = useStream(api.serviceStatus);
  const statusType = serviceStatus.data.status?.status;
  const started = statusType === ServiceStatus_Type.STARTED;

  let stateLabel: string | null = null;
  if (serviceStatus.phase === "active" && !started) {
    switch (statusType) {
      case ServiceStatus_Type.STARTING:
        stateLabel = t("Service starting...");
        break;
      case ServiceStatus_Type.STOPPING:
        stateLabel = t("Service stopping...");
        break;
      case ServiceStatus_Type.FATAL:
        stateLabel = t("Service failed to start");
        break;
      default:
        stateLabel = t("Service not started");
        break;
    }
  }

  return (
    <div className="page">
      <PageHeader title={t("Overview")} actions={started ? <ModeSwitch /> : undefined} />
      <StreamBanner snapshot={serviceStatus} />
      {started ? (
        <OverviewDashboard />
      ) : (
        stateLabel !== null && <EmptyState icon="dashboard">{stateLabel}</EmptyState>
      )}
    </div>
  );
}

function ModeSwitch() {
  const api = useApi();
  const clashMode = useStream(api.clashMode);
  const [currentMode, setPendingMode, switchingMode] = usePendingValue(clashMode.data.currentMode);
  const modes = clashMode.data.modeList;
  if (modes.length <= 1) {
    return null;
  }
  return (
    <div className="segmented" role="radiogroup">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={mode === currentMode}
          className={mode === currentMode ? "active" : ""}
          onClick={() => {
            if (mode === currentMode) {
              return;
            }
            setPendingMode(mode);
            api.setClashMode(mode).catch((error: unknown) => {
              setPendingMode(null);
              showError(error);
            });
          }}
        >
          {switchingMode && mode === currentMode && <Spinner className={styles.modeSpinner} />}
          {mode}
        </button>
      ))}
    </div>
  );
}

function OverviewDashboard() {
  const providers = useExtension("outbound_provider");
  const dnsLog = useExtension("dns_query_log");
  const pair = providers && dnsLog;

  return (
    <div className={styles.dashboard}>
      <KpiStrip />
      <TrafficCard />
      <TopologyCard />
      {(providers || dnsLog) && (
        <div className={cx(styles.bottomGrid, !pair && styles.bottomSingle)}>
          {providers && <ProvidersSummaryCard />}
          {dnsLog && <DnsSummaryCard />}
        </div>
      )}
    </div>
  );
}

function rate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function splitUnit(text: string): [string, string] {
  const index = text.lastIndexOf(" ");
  return index > 0 ? [text.slice(0, index), text.slice(index + 1)] : [text, ""];
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

function smoothLinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) {
    return "";
  }
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return path;
}

/* ----------------------------------------------------------- KPI strip */

type SparkTone = "cobalt" | "accent" | "good" | "ink";

const KPI_TONE_CLASS: Record<SparkTone, string> = {
  cobalt: styles.kpiCobalt,
  accent: styles.kpiAccent,
  good: styles.kpiGood,
  ink: styles.kpiInk,
};

function KpiStrip() {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const connections = useStream(api.connections);
  const current = status.data.current;
  const available = current?.trafficAvailable ?? false;

  const downHistory = status.data.downlinkHistory;
  const upHistory = status.data.uplinkHistory;
  const memoryHistory = status.data.memoryHistory;
  const goroutineHistory = status.data.goroutineHistory;

  const [downValue, downUnit] = splitUnit(available ? rate(Number(current?.downlink ?? 0)) : "— B/s");
  const [upValue, upUnit] = splitUnit(available ? rate(Number(current?.uplink ?? 0)) : "— B/s");
  const downPeak = downHistory.length > 0 ? rate(Math.max(...downHistory)) : "—";
  const upPeak = upHistory.length > 0 ? rate(Math.max(...upHistory)) : "—";

  const [memoryValue, memoryUnit] = splitUnit(formatMemoryBytes(Number(current?.memory ?? 0)));
  const memoryPeak = memoryHistory.length > 0 ? formatMemoryBytes(Math.max(...memoryHistory)) : "—";
  const memoryLow = memoryHistory.length > 0 ? formatMemoryBytes(Math.min(...memoryHistory)) : "—";

  const activeConns = connections.data.loaded
    ? connections.data.rows.size
    : Number(current?.connectionsIn ?? 0);
  const goroutines = current?.goroutines ?? 0;
  const goroutineMin = goroutineHistory.length > 0 ? Math.min(...goroutineHistory) : 0;
  const goroutineMax = goroutineHistory.length > 0 ? Math.max(...goroutineHistory) : 0;

  return (
    <div className={styles.kpiGrid}>
      <KpiCard
        label={t("Download")}
        badge={available ? `${t("High")} ${downPeak}` : undefined}
        badgeTone="info"
        value={downValue}
        unit={available ? downUnit : undefined}
        foot={`${t("Total")} ${available ? formatBytes(Number(current?.downlinkTotal ?? 0)) : "—"}`}
        series={downHistory}
        capacity={STATUS_HISTORY_LENGTH}
        tone="cobalt"
      />
      <KpiCard
        label={t("Upload")}
        badge={available ? `${t("High")} ${upPeak}` : undefined}
        badgeTone="neutral"
        value={upValue}
        unit={available ? upUnit : undefined}
        foot={`${t("Total")} ${available ? formatBytes(Number(current?.uplinkTotal ?? 0)) : "—"}`}
        series={upHistory}
        capacity={STATUS_HISTORY_LENGTH}
        tone="accent"
      />
      <KpiCard
        label={t("Connections")}
        badge={current ? `${goroutines} ${t("Goroutines")}` : undefined}
        badgeTone={activeConns > 0 ? "good" : "neutral"}
        value={current || connections.data.loaded ? activeConns.toLocaleString() : "—"}
        foot={
          goroutineHistory.length > 0
            ? `${t("Goroutines")} ${t("Low")} ${goroutineMin} · ${t("High")} ${goroutineMax}`
            : "—"
        }
        series={goroutineHistory}
        capacity={STATUS_HISTORY_LENGTH}
        tone="good"
        onClick={() => navigate("connections")}
      />
      <KpiCard
        label={t("Memory")}
        badge={current ? `${t("High")} ${memoryPeak}` : undefined}
        badgeTone="neutral"
        value={current ? memoryValue : "—"}
        unit={current ? memoryUnit : undefined}
        foot={
          memoryHistory.length > 0
            ? `${t("Low")} ${memoryLow} · ${t("High")} ${memoryPeak}`
            : "—"
        }
        series={memoryHistory}
        capacity={STATUS_HISTORY_LENGTH}
        tone="ink"
      />
    </div>
  );
}

function KpiCard(props: {
  label: string;
  badge?: string;
  badgeTone?: BadgeTone;
  value: string;
  unit?: string;
  foot: string;
  series: number[];
  capacity: number;
  tone: SparkTone;
  onClick?: () => void;
}) {
  const width = 260;
  const height = 42;
  const data = props.series;
  const min = data.length > 0 ? Math.min(...data) : 0;
  const max = data.length > 0 ? Math.max(...data) : 1;
  const hasSignal = max > 0;
  const floor = props.tone === "ink" || props.tone === "good" ? Math.max(0, min * 0.85) : 0;
  const span = Math.max(max - floor, 1);
  const offset = Math.max(0, props.capacity - data.length);
  const denom = Math.max(props.capacity - 1, 1);

  const points = data.map((val, index) => ({
    x: ((offset + index) / denom) * width,
    y: hasSignal ? height - 3 - ((val - floor) / span) * (height - 10) : height - 3,
  }));
  const strokePath = smoothLinePath(points);
  const areaPath =
    points.length > 1
      ? `${strokePath} L ${points[points.length - 1].x.toFixed(1)} ${height} L ${points[0].x.toFixed(1)} ${height} Z`
      : "";

  const content = (
    <>
      <div className={styles.kpiTop}>
        <span className={styles.kpiLabel}>{props.label}</span>
        {props.badge && <Badge tone={props.badgeTone}>{props.badge}</Badge>}
      </div>
      <div className={styles.kpiValue}>
        {props.value}
        {props.unit && <span className={styles.kpiUnit}>{props.unit}</span>}
      </div>
      <div className={styles.kpiFoot}>{props.foot}</div>
      <div className={styles.kpiSpark} aria-hidden="true">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          {areaPath !== "" && <path d={areaPath} className={styles.kpiSparkArea} />}
          {strokePath !== "" && <path d={strokePath} className={styles.kpiSparkLine} />}
        </svg>
      </div>
    </>
  );

  if (props.onClick) {
    return (
      <button
        type="button"
        className={cx(styles.kpiCard, styles.kpiInteractive, KPI_TONE_CLASS[props.tone])}
        onClick={props.onClick}
      >
        {content}
      </button>
    );
  }

  return <div className={cx(styles.kpiCard, KPI_TONE_CLASS[props.tone])}>{content}</div>;
}

/* ------------------------------------------------------------- traffic */

function TrafficCard() {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const current = status.data.current;
  const available = current?.trafficAvailable ?? false;
  const up = status.data.uplinkHistory;
  const down = status.data.downlinkHistory;

  const [chartRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 196;
  const axisBottom = 22;
  const padTop = 10;
  const padX = 8;
  const plotHeight = height - axisBottom;
  const capacity = STATUS_HISTORY_LENGTH;
  const offset = Math.max(0, capacity - up.length);
  const step = width > 0 ? (width - padX * 2) / Math.max(capacity - 1, 1) : 0;

  const scaleMax = niceCeil(Math.max(...up, ...down, 1024));
  const xAt = (index: number) => padX + (offset + index) * step;
  const yAt = (value: number) => padTop + (1 - Math.min(value, scaleMax) / scaleMax) * (plotHeight - padTop);

  const downPoints = useMemo(
    () => down.map((val, i) => ({ x: xAt(i), y: yAt(val) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [down, step, offset, scaleMax],
  );
  const upPoints = useMemo(
    () => up.map((val, i) => ({ x: xAt(i), y: yAt(val) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [up, step, offset, scaleMax],
  );

  const areaFor = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) {
      return "";
    }
    return `${smoothLinePath(pts)} L ${pts[pts.length - 1].x.toFixed(1)} ${plotHeight} L ${pts[0].x.toFixed(1)} ${plotHeight} Z`;
  };

  const hovered = hover !== null && hover >= 0 && hover < up.length ? hover : null;

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon="network_check" small />
        <span className={styles.cardTitle}>{t("Traffic")}</span>
        <span className={styles.cardSubtitle}>
          {t("Last {count} seconds", { count: STATUS_HISTORY_LENGTH })}
        </span>
        <div className={styles.cardActions}>
          <div className={styles.trafficLegend}>
            <span className={styles.legendItem}>
              <span className="swatch down" />
              {t("Download")}
              <strong className="mono">{available ? rate(Number(current?.downlink ?? 0)) : "—"}</strong>
            </span>
            <span className={styles.legendItem}>
              <span className="swatch up" />
              {t("Upload")}
              <strong className="mono">{available ? rate(Number(current?.uplink ?? 0)) : "—"}</strong>
            </span>
          </div>
          <span className={cx("live-tag", status.phase !== "active" && "idle")}>
            {t("Live")} · 1s
          </span>
        </div>
      </header>
      {available ? (
        <div
          ref={chartRef}
          className={styles.trafficChart}
          style={{ height }}
          role="img"
          aria-label={`${t("Download")} ${rate(down[down.length - 1] ?? 0)}, ${t("Upload")} ${rate(up[up.length - 1] ?? 0)}`}
          onPointerMove={(event) => {
            if (step <= 0 || up.length === 0) {
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const index = Math.round((event.clientX - rect.left - padX) / step) - offset;
            setHover(Math.max(0, Math.min(up.length - 1, index)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {width > 0 && (
            <>
              <svg width={width} height={height} className={styles.chartSvg} aria-hidden="true">
                <line x1={padX} x2={width - padX} y1={padTop} y2={padTop} className={styles.gridLine} />
                <line
                  x1={padX}
                  x2={width - padX}
                  y1={Math.round((padTop + plotHeight) / 2)}
                  y2={Math.round((padTop + plotHeight) / 2)}
                  className={styles.gridLine}
                />
                <line x1={padX} x2={width - padX} y1={plotHeight} y2={plotHeight} className={styles.gridBaseline} />

                {downPoints.length > 1 && (
                  <>
                    <path d={areaFor(downPoints)} className={styles.areaDown} />
                    <path d={smoothLinePath(downPoints)} className={styles.lineDown} />
                  </>
                )}
                {upPoints.length > 1 && (
                  <>
                    <path d={areaFor(upPoints)} className={styles.areaUp} />
                    <path d={smoothLinePath(upPoints)} className={styles.lineUp} />
                  </>
                )}

                {hovered !== null && downPoints[hovered] && upPoints[hovered] && (
                  <g>
                    <line
                      x1={downPoints[hovered].x}
                      x2={downPoints[hovered].x}
                      y1={padTop}
                      y2={plotHeight}
                      className={styles.hoverGuide}
                    />
                    <circle
                      cx={downPoints[hovered].x}
                      cy={downPoints[hovered].y}
                      r={3.5}
                      className={styles.dotDown}
                    />
                    <circle
                      cx={upPoints[hovered].x}
                      cy={upPoints[hovered].y}
                      r={3.5}
                      className={styles.dotUp}
                    />
                  </g>
                )}

                {[60, 45, 30, 15, 0].map((secondsAgo) => {
                  const x =
                    padX +
                    ((capacity - 1 - secondsAgo) / Math.max(capacity - 1, 1)) * (width - padX * 2);
                  return (
                    <text
                      key={secondsAgo}
                      x={Math.min(Math.max(x, padX), width - padX)}
                      y={height - 4}
                      className={styles.axisLabel}
                      textAnchor={secondsAgo === 60 ? "start" : secondsAgo === 0 ? "end" : "middle"}
                    >
                      {secondsAgo === 0 ? t("now") : `-${secondsAgo}s`}
                    </text>
                  );
                })}
              </svg>
              <span className={styles.yLabelTop}>{rate(scaleMax)}</span>
              <span className={styles.yLabelMid}>{rate(Math.round(scaleMax / 2))}</span>
              {hovered !== null && (
                <div
                  className={cx("tooltip-card", styles.chartTooltip)}
                  style={{
                    left: Math.min(Math.max(xAt(hovered) - 76, 8), Math.max(width - 172, 8)),
                    top: 8,
                  }}
                >
                  <div className="faint mono">
                    {up.length - 1 - hovered === 0 ? t("now") : `-${up.length - 1 - hovered}s`}
                  </div>
                  <div className="tooltip-rows">
                    <span className={styles.legendItem}>
                      <span className="swatch down" />
                      {t("Download")}
                    </span>
                    <span>{rate(down[hovered] ?? 0)}</span>
                    <span className={styles.legendItem}>
                      <span className="swatch up" />
                      {t("Upload")}
                    </span>
                    <span>{rate(up[hovered] ?? 0)}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <EmptyState icon="network_check">{t("Traffic statistics are not available")}</EmptyState>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- topology */

const EMPTY_TOPOLOGY = buildTopology([]);

const COLUMN_LABELS: Record<TopologyColumn, MessageKey> = {
  source: "Sources",
  inbound: "Inbound",
  group: "Groups",
  exit: "Exits",
  internet: "Upstream",
};

function connectionsFilter(node: TopologyNode): string {
  if (node.members) {
    return "";
  }
  const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replaceAll('"', "")}"` : value);
  switch (node.column) {
    case "source":
      if (node.kind === "app") {
        return `process:${quote(node.label)}`;
      }
      if (node.kind === "device" || node.kind === "tailscale") {
        const address = node.addresses[0] ?? "";
        return `source:${address.includes(":") ? `[${address}]` : `${address}:`}`;
      }
      return "";
    case "inbound":
      return node.tag !== "" ? `inbound:${quote(node.tag)}` : "";
    case "group":
      return `chain:${quote(node.tag)}`;
    case "exit":
      return `outbound:${quote(node.tag)}`;
    default:
      return "";
  }
}

function connectionsPath(node: TopologyNode): string {
  const filter = connectionsFilter(node);
  return filter === "" ? "connections" : `connections?q=${encodeURIComponent(filter)}`;
}

function TopologyCard() {
  const api = useApi();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const connections = useStream(api.connections);
  const groups = useStream(api.groups);
  const info = useUnaryOnce(() => api.serverInfo());
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const rows = connections.data.rows;
  const [built, setBuilt] = useState<{ rows: typeof rows | null; model: TopologyModel }>({
    rows: null,
    model: EMPTY_TOPOLOGY,
  });
  let model = built.model;
  if (built.rows !== rows) {
    model = buildTopology(rows.values(), built.model.order);
    setBuilt({ rows, model });
  }

  const totals = model.totals;
  const sources = model.columns.source.reduce((sum, node) => sum + (node.members?.length ?? 1), 0);
  const core = (
    <>
      <span className={styles.coreDot} />
      <span>sing-box</span>
      {info && <span className="mono faint">{info.version}</span>}
    </>
  );

  return (
    <section className={cx(styles.surfaceCard, styles.topologyCard)}>
      <header className={styles.cardHead}>
        <IconTile icon="waypoints" small />
        <span className={styles.cardTitle}>{t("Traffic topology")}</span>
        <span className={styles.cardSubtitle}>
          {totals.conns > 0
            ? t("{count} active connections from {sources} sources", { count: totals.conns, sources })
            : t("Hover a node to trace its paths")}
        </span>
        <div className={styles.cardActions}>
          {totals.conns > 0 && !isMobile && (
            <span className={cx("mono", styles.topologyRates)}>
              <span>
                <span className="swatch down" /> {rate(totals.down)}
              </span>
              <span>
                <span className="swatch up" /> {rate(totals.up)}
              </span>
            </span>
          )}
          {!isMobile && (
            <Button size="small" disabled={totals.conns === 0} onClick={() => setConfirming(true)}>
              {t("Close all")}
            </Button>
          )}
          <button type="button" className={styles.linkButton} onClick={() => navigate("connections")}>
            {t("Connections")}
            <Icon name="keyboard_arrow_right" size={14} />
          </button>
        </div>
      </header>
      {!connections.data.loaded ? (
        <EmptyState icon="waypoints">{t("Loading...")}</EmptyState>
      ) : totals.conns === 0 ? (
        <EmptyState icon="waypoints">{t("No active connections")}</EmptyState>
      ) : (
        <Topology
          model={model}
          groups={groups.data.groups}
          core={core}
          selected={selected}
          onSelect={(node) => {
            if (isMobile) {
              navigate(connectionsPath(node));
            } else {
              setSelected(node.key);
            }
          }}
        />
      )}
      {selected !== null && !isMobile && (
        <TopologyDetail
          model={model}
          nodeKey={selected}
          groups={groups.data.groups}
          onClose={() => setSelected(null)}
        />
      )}
      {confirming && (
        <Dialog onClose={() => setConfirming(false)}>
          <h3>{t("Close all connections?")}</h3>
          <p className="dialog-message">
            {t("Every active connection will be closed. Applications reconnect on their own.")}
          </p>
          <div className="row-actions dialog-actions">
            <Button onClick={() => setConfirming(false)}>{t("Cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                api.closeAllConnections().catch(showError);
              }}
            >
              {t("Close all")}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function findTopologyNode(model: TopologyModel, key: string): TopologyNode | undefined {
  for (const column of TOPOLOGY_COLUMNS) {
    for (const node of model.columns[column]) {
      if (node.key === key) {
        return node;
      }
      const member = node.members?.find((entry) => entry.key === key);
      if (member) {
        return member;
      }
    }
  }
  return undefined;
}

const DETAIL_CONNECTIONS = 30;

function TopologyDetail(props: {
  model: TopologyModel;
  nodeKey: string;
  groups: Group[];
  onClose: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const label = useTopologyLabel();
  const node = findTopologyNode(props.model, props.nodeKey);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);

  if (!node) {
    return (
      <DetailShell backLabel={t("Overview")} title={t("Traffic topology")} onClose={props.onClose}>
        <EmptyState icon="waypoints">{t("No active connections")}</EmptyState>
      </DetailShell>
    );
  }

  const passing = connectionsThrough(props.model, node.key);
  const top = [...passing]
    .sort(
      (left, right) =>
        right.row.uplinkRate + right.row.downlinkRate - (left.row.uplinkRate + left.row.downlinkRate) ||
        Number(right.row.connection.createdAt - left.row.connection.createdAt),
    )
    .slice(0, DETAIL_CONNECTIONS);
  const group =
    node.column === "group" ? props.groups.find((entry) => entry.tag === node.tag) : undefined;
  const filter = connectionsFilter(node);

  return (
    <DetailShell
      backLabel={t("Overview")}
      title={label(node)}
      accessory={<Badge>{t(COLUMN_LABELS[node.column])}</Badge>}
      onClose={props.onClose}
    >
      <div className={styles.detailStats}>
        <div>
          <div className="metric-label">
            <span className="swatch down" />
            {t("Download")}
          </div>
          <span className={styles.detailValue}>{rate(node.down)}</span>
        </div>
        <div>
          <div className="metric-label">
            <span className="swatch up" />
            {t("Upload")}
          </div>
          <span className={styles.detailValue}>{rate(node.up)}</span>
        </div>
        <div>
          <div className="metric-label">{t("Connections")}</div>
          <span className={styles.detailValue}>{node.conns}</span>
        </div>
      </div>
      {(node.type || node.addresses.length > 0) && (
        <DetailSection title={t("Details")}>
          {node.type && (
            <DataLine
              label={t("Type")}
              value={
                node.column === "inbound"
                  ? inboundDisplayType(node.type)
                  : proxyDisplayType(node.type)
              }
            />
          )}
          {node.column === "source" && node.addresses.length > 0 && (
            <DataLine label={t("Addresses")} value={node.addresses.join(", ")} mono />
          )}
        </DetailSection>
      )}
      {node.members && (
        <DetailSection title={t("Members")}>
          <div className={styles.detailList}>
            {node.members.map((member) => (
              <div key={member.key} className={styles.detailRow}>
                <span className={styles.detailMain}>{label(member)}</span>
                <span className={cx("mono", styles.detailRate)}>
                  {nodeRate(member) > 0
                    ? rate(nodeRate(member))
                    : t("{count} connections", { count: member.conns })}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}
      {group && (
        <DetailSection
          title={`${proxyDisplayType(group.type)} · ${t("{count} nodes", { count: group.items.length })}`}
        >
          <div className={styles.detailList}>
            {group.items.map((item) => {
              const current = (pendingSelection ?? group.selected) === item.tag;
              const split = splitNodeTag(item.tag);
              return (
                <button
                  key={item.tag}
                  type="button"
                  className={cx(styles.detailRow, styles.memberRow, current && styles.memberCurrent)}
                  disabled={!group.selectable || current}
                  onClick={() => {
                    setPendingSelection(item.tag);
                    api
                      .selectOutbound(group.tag, item.tag)
                      .catch(showError)
                      .finally(() => setPendingSelection(null));
                  }}
                >
                  <span className={styles.memberMarker} />
                  <span className={styles.detailMain}>
                    {split.flag !== "" && <span className={styles.memberFlag}>{split.flag}</span>}
                    {split.name}
                  </span>
                  <span
                    className={cx(
                      "mono",
                      styles.detailRate,
                      item.urlTestDelay > 0 && styles[urlTestDelayTone(item.urlTestDelay)],
                    )}
                  >
                    {item.urlTestDelay > 0 ? `${item.urlTestDelay} ms` : proxyDisplayType(item.type)}
                  </span>
                </button>
              );
            })}
          </div>
        </DetailSection>
      )}
      <DetailSection
        title={t("Active connections")}
        accessory={
          <button
            type="button"
            className={styles.linkButton}
            onClick={() =>
              navigate(filter === "" ? "connections" : `connections?q=${encodeURIComponent(filter)}`)
            }
          >
            {t("Show in Connections")}
            <Icon name="keyboard_arrow_right" size={14} />
          </button>
        }
      >
        <div className={styles.detailList}>
          {top.map(({ row, chain }) => {
            const connection = row.connection;
            const value = row.uplinkRate + row.downlinkRate;
            const process = processName(connection);
            const route = [
              node.column !== "source"
                ? process !== ""
                  ? process
                  : hostOf(connection.source)
                : "",
              chain.join(" → "),
            ].filter((part) => part !== "");
            return (
              <div key={connection.id} className={styles.detailRow}>
                <span className={styles.detailMain}>
                  <span className={styles.detailTitle}>
                    {connection.domain || connection.destination}
                  </span>
                  <span className={styles.detailSub}>
                    {connection.network.toUpperCase()} · {route.join(" · ")}
                  </span>
                </span>
                <span className={cx("mono", styles.detailRate, value === 0 && "faint")}>
                  {value > 0 ? rate(value) : "—"}
                </span>
              </div>
            );
          })}
          {passing.length > top.length && (
            <div className="metric-foot">{t("{count} more", { count: passing.length - top.length })}</div>
          )}
        </div>
      </DetailSection>
    </DetailShell>
  );
}

/* ------------------------------------------------------------ providers */

function useScrollActivity() {
  const [scrolling, setScrolling] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const onScroll = () => {
    setScrolling(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setScrolling(false);
      timerRef.current = null;
    }, 750);
  };

  return { scrolling, onScroll };
}

function ProvidersSummaryCard() {
  const api = useApi();
  const { t, language } = useI18n();
  const now = useNow(30_000);
  const providers = useStream(api.extended.providers);
  const list = providers.data.providers;
  const { scrolling, onScroll } = useScrollActivity();

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon="provider" small />
        <span className={styles.cardTitle}>{t("Providers")}</span>
        <span className={styles.cardSubtitle}>{t("{count} subscriptions", { count: list.length })}</span>
        <div className={styles.cardActions}>
          <button type="button" className={styles.linkButton} onClick={() => navigate("providers")}>
            {t("Manage")}
            <Icon name="keyboard_arrow_right" size={14} />
          </button>
        </div>
      </header>
      {!providers.data.loaded ? (
        <EmptyState>{t("Loading...")}</EmptyState>
      ) : list.length === 0 ? (
        <EmptyState icon="provider">{t("No providers configured")}</EmptyState>
      ) : (
        <div
          className={cx(styles.providerList, scrolling && styles.scrolling)}
          onScroll={onScroll}
        >
          {list.map((provider) => {
            const info = provider.subscriptionInfo;
            const used = info ? Number(info.upload + info.download) : 0;
            const quota = info ? Number(info.total) : 0;
            const ratio = quota > 0 ? used / quota : 0;
            return (
              <button
                key={provider.tag}
                type="button"
                className={styles.providerCard}
                onClick={() => navigate("providers")}
              >
                <div className={styles.providerTop}>
                  <span className={styles.providerName}>{provider.tag}</span>
                  <Badge>{provider.items.length}</Badge>
                  {provider.lastError !== "" && <Badge tone="bad">{t("Error")}</Badge>}
                  <span className={styles.providerRight}>
                    {quota > 0
                      ? `${Math.min(100, Math.round(ratio * 100))}%`
                      : provider.updatedAt > 0n
                        ? formatRelativeTime(Number(provider.updatedAt) * 1000, now, language)
                        : t("Never updated")}
                  </span>
                </div>
                {quota > 0 ? (
                  <>
                    <Meter value={ratio} tone={ratio > 0.85 ? "warn" : undefined} />
                    <div className={styles.providerFoot}>
                      <span>
                        <strong>{formatBytes(used)}</strong> / {formatBytes(quota)}
                      </span>
                      {info && info.expireTime > 0n && (
                        <span>
                          {t("Expires {time}", {
                            time: formatRelativeTime(Number(info.expireTime) * 1000, now, language),
                          })}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className={styles.providerFoot}>
                    <span>
                      {provider.updatedAt > 0n
                        ? t("Updated {time}", {
                            time: formatRelativeTime(Number(provider.updatedAt) * 1000, now, language),
                          })
                        : t("Never updated")}
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ DNS */

const DAY_MS = 24 * 60 * 60 * 1000;

function DnsSummaryCard() {
  const api = useApi();
  const { t, language } = useI18n();
  const cache = useExtension("dns_cache");
  const { stats, loading, reload } = useDnsStats({ span: DAY_MS, bucket: 3600, top: 5, quiet: true });
  const [flushing, setFlushing] = useState(false);

  const total = Number(stats?.total ?? 0);
  const blocked = Number(stats?.statuses.rejected ?? 0n);
  const cached = Number(stats?.statuses.cached ?? 0n) + Number(stats?.statuses.optimistic ?? 0n);
  const buckets = useMemo(() => stats?.buckets ?? [], [stats]);
  const average = Number(stats?.upstreamDuration?.average ?? 0n) / 1000;

  const [chartRef, chartWidth] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 132;
  const axisBottom = 20;
  const padTop = 8;
  const padX = 6;
  const plotHeight = height - axisBottom;
  const scaleMax = niceCeil(Math.max(...buckets.map((b) => Number(b.total)), 1));
  const count = buckets.length;
  const step = count > 1 && chartWidth > 0 ? (chartWidth - padX * 2) / (count - 1) : 0;

  const xAt = (index: number) => padX + index * step;
  const yAt = (value: number) => padTop + (1 - Math.min(value, scaleMax) / scaleMax) * (plotHeight - padTop);

  const totalPoints = useMemo(
    () => buckets.map((b, i) => ({ x: xAt(i), y: yAt(Number(b.total)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, step, scaleMax],
  );
  const cachedPoints = useMemo(
    () =>
      buckets.map((b, i) => ({
        x: xAt(i),
        y: yAt(Number(b.statuses.cached ?? 0n) + Number(b.statuses.optimistic ?? 0n)),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, step, scaleMax],
  );
  const blockedPoints = useMemo(
    () => buckets.map((b, i) => ({ x: xAt(i), y: yAt(Number(b.statuses.rejected ?? 0n)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, step, scaleMax],
  );

  const areaFor = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) {
      return "";
    }
    return `${smoothLinePath(pts)} L ${pts[pts.length - 1].x.toFixed(1)} ${plotHeight} L ${pts[0].x.toFixed(1)} ${plotHeight} Z`;
  };

  const hoveredIndex = hover !== null && hover >= 0 && hover < count ? hover : null;
  const hoveredBucket = hoveredIndex !== null ? buckets[hoveredIndex] : undefined;

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon="dns" small />
        <span className={styles.cardTitle}>DNS</span>
        <span className={styles.cardSubtitle}>{t("24 hours")}</span>
        <div className={styles.cardActions}>
          {cache && (
            <Button
              size="small"
              disabled={flushing}
              onClick={() => {
                setFlushing(true);
                api.extended
                  .clearDnsCache()
                  .catch(showError)
                  .finally(() => setFlushing(false));
              }}
            >
              {flushing ? <Spinner /> : <Icon name="eraser" size={13} />}
              {t("Flush cache")}
            </Button>
          )}
          <Button
            size="small"
            disabled={loading}
            onClick={reload}
            aria-label={t("Refresh")}
            title={t("Refresh")}
          >
            {loading ? <Spinner /> : <Icon name="sync" size={13} />}
          </Button>
          <button type="button" className={styles.linkButton} onClick={() => navigate("dns")}>
            DNS
            <Icon name="keyboard_arrow_right" size={14} />
          </button>
        </div>
      </header>

      <div className={styles.dnsStatsGrid}>
        <button type="button" className={styles.dnsStatBox} onClick={() => navigate("dns")}>
          <span className={styles.dnsStatLabel}>{t("Queries")}</span>
          <span className={styles.dnsStatValue}>{stats ? total.toLocaleString() : "—"}</span>
        </button>
        <button type="button" className={styles.dnsStatBox} onClick={() => navigate("dns")}>
          <span className={styles.dnsStatLabel}>{t("From cache")}</span>
          <span className={styles.dnsStatValue}>
            {stats ? (total > 0 ? `${((cached / total) * 100).toFixed(1)}%` : "0.0%") : "—"}
          </span>
        </button>
        <button type="button" className={styles.dnsStatBox} onClick={() => navigate("dns")}>
          <span className={styles.dnsStatLabel}>{t("Blocked")}</span>
          <span className={styles.dnsStatValue}>
            {stats ? blocked.toLocaleString() : "—"}
            {stats && total > 0 && (
              <span className={styles.dnsStatSub}>{((blocked / total) * 100).toFixed(1)}%</span>
            )}
          </span>
        </button>
        <button type="button" className={styles.dnsStatBox} onClick={() => navigate("dns")}>
          <span className={styles.dnsStatLabel}>{t("Upstream avg")}</span>
          <span className={styles.dnsStatValue}>
            {stats && average > 0 ? formatDurationMs(average).replace(/([a-zµ]+)$/i, " $1") : "—"}
          </span>
        </button>
      </div>

      <div
        ref={chartRef}
        className={styles.dnsChartWrap}
        style={{ height }}
        role="img"
        aria-label={`${t("Queries")}: ${total.toLocaleString()}`}
        onPointerMove={(event) => {
          if (step <= 0 || count === 0) {
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const idx = Math.round((event.clientX - rect.left - padX) / step);
          setHover(Math.max(0, Math.min(count - 1, idx)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {chartWidth > 0 && count > 1 && (
          <>
            <svg width={chartWidth} height={height} className={styles.chartSvg} aria-hidden="true">
              <line x1={padX} x2={chartWidth - padX} y1={padTop} y2={padTop} className={styles.gridLine} />
              <line
                x1={padX}
                x2={chartWidth - padX}
                y1={Math.round((padTop + plotHeight) / 2)}
                y2={Math.round((padTop + plotHeight) / 2)}
                className={styles.gridLine}
              />
              <line x1={padX} x2={chartWidth - padX} y1={plotHeight} y2={plotHeight} className={styles.gridBaseline} />

              <path d={areaFor(totalPoints)} className={styles.areaTotal} />
              <path d={smoothLinePath(totalPoints)} className={styles.lineTotal} />

              <path d={areaFor(cachedPoints)} className={styles.areaDown} />
              <path d={smoothLinePath(cachedPoints)} className={styles.lineDown} />

              <path d={areaFor(blockedPoints)} className={styles.areaBlocked} />
              <path d={smoothLinePath(blockedPoints)} className={styles.lineBlocked} />

              {hoveredIndex !== null && (
                <g>
                  <line
                    x1={totalPoints[hoveredIndex].x}
                    x2={totalPoints[hoveredIndex].x}
                    y1={padTop}
                    y2={plotHeight}
                    className={styles.hoverGuide}
                  />
                  <circle
                    cx={totalPoints[hoveredIndex].x}
                    cy={totalPoints[hoveredIndex].y}
                    r={3}
                    className={styles.dotTotal}
                  />
                  <circle
                    cx={cachedPoints[hoveredIndex].x}
                    cy={cachedPoints[hoveredIndex].y}
                    r={3}
                    className={styles.dotDown}
                  />
                  <circle
                    cx={blockedPoints[hoveredIndex].x}
                    cy={blockedPoints[hoveredIndex].y}
                    r={3}
                    className={styles.dotBlocked}
                  />
                </g>
              )}

              <text x={padX} y={height - 4} textAnchor="start" className={styles.axisLabel}>
                -24h
              </text>
              <text x={chartWidth / 2} y={height - 4} textAnchor="middle" className={styles.axisLabel}>
                -12h
              </text>
              <text x={chartWidth - padX} y={height - 4} textAnchor="end" className={styles.axisLabel}>
                {t("now")}
              </text>
            </svg>
            {hoveredBucket && hoveredIndex !== null && (
              <div
                className={cx("tooltip-card", styles.chartTooltip)}
                style={{
                  left: Math.min(Math.max(xAt(hoveredIndex) - 70, 8), Math.max(chartWidth - 160, 8)),
                  top: 4,
                }}
              >
                <div className="tooltip-value">{Number(hoveredBucket.total).toLocaleString()}</div>
                <div className="tooltip-rows">
                  <span>{t("From cache")}</span>
                  <span>
                    {(
                      Number(hoveredBucket.statuses.cached ?? 0n) +
                      Number(hoveredBucket.statuses.optimistic ?? 0n)
                    ).toLocaleString()}
                  </span>
                  <span>{t("Blocked")}</span>
                  <span>{Number(hoveredBucket.statuses.rejected ?? 0n).toLocaleString()}</span>
                </div>
                <div className="tooltip-meta">
                  {new Date(Number(hoveredBucket.time)).toLocaleTimeString(language, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
