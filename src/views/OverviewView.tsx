import { useState } from "react";

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
import { Board, Meter, Metric, Panel, PanelHead } from "../components/Board";
import { BarTooltip, SmoothLine, TrafficStems, useElementWidth } from "../components/charts";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamBanner } from "../components/StreamBanner";
import { Topology, useTopologyLabel } from "../components/Topology";
import { Badge, Button, DataLine, DetailSection, DetailShell, Dialog, EmptyState, Spinner } from "../components/ui";
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
        <OverviewBoard />
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

function OverviewBoard() {
  const providers = useExtension("outbound_provider");
  const dnsLog = useExtension("dns_query_log");
  // Providers and DNS share a row; whichever the core has alone takes it.
  const pair = providers && dnsLog;
  return (
    <Board>
      <TrafficPanel />
      <CorePanel />
      <TopologyPanel />
      {providers && <ProvidersSummaryPanel span={pair ? 6 : 12} />}
      {dnsLog && <DnsSummaryPanel span={pair ? 6 : 12} />}
    </Board>
  );
}

function rate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function splitUnit(text: string): [string, string] {
  const index = text.lastIndexOf(" ");
  return index > 0 ? [text.slice(0, index), text.slice(index + 1)] : [text, ""];
}

/* -------------------------------------------------------------- traffic */

function TrafficPanel() {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const current = status.data.current;
  const available = current?.trafficAvailable ?? false;
  const [upValue, upUnit] = splitUnit(available ? rate(Number(current?.uplink ?? 0)) : "— B/s");
  const [downValue, downUnit] = splitUnit(available ? rate(Number(current?.downlink ?? 0)) : "— B/s");

  return (
    <Panel span={8}>
      <PanelHead
        icon="network_check"
        title={t("Traffic")}
        subtitle={t("Last {count} seconds", { count: STATUS_HISTORY_LENGTH })}
        actions={<span className={cx("live-tag", status.phase !== "active" && "idle")}>{t("Live")} · 1s</span>}
      />
      <div className={styles.trafficBody}>
        <div className={styles.trafficStats}>
          <div>
            <div className="metric-label">
              <span className="swatch up" />
              {t("Upload")}
            </div>
            <Metric value={upValue} unit={upUnit} />
            <div className="metric-foot">
              {t("Total")} <strong>{available ? formatBytes(Number(current?.uplinkTotal ?? 0)) : "—"}</strong>
            </div>
          </div>
          <div className={styles.trafficDivider} />
          <div>
            <div className="metric-label">
              <span className="swatch down" />
              {t("Download")}
            </div>
            <Metric value={downValue} unit={downUnit} />
            <div className="metric-foot">
              {t("Total")} <strong>{available ? formatBytes(Number(current?.downlinkTotal ?? 0)) : "—"}</strong>
            </div>
          </div>
        </div>
        <div className={styles.trafficChart}>
          {available ? (
            <TrafficStems
              up={status.data.uplinkHistory}
              down={status.data.downlinkHistory}
              capacity={STATUS_HISTORY_LENGTH}
              format={rate}
              labels={{ up: t("Upload"), down: t("Download"), now: t("now") }}
            />
          ) : (
            <EmptyState icon="network_check">{t("Traffic statistics are not available")}</EmptyState>
          )}
        </div>
      </div>
    </Panel>
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

// The connections page search that matches what passes a node, or "" when
// no single filter does.
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

function TopologyPanel() {
  const api = useApi();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const connections = useStream(api.connections);
  const groups = useStream(api.groups);
  const info = useUnaryOnce(() => api.serverInfo());
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Each model starts from the last one's column order so nodes stay put.
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
    <Panel className={styles.topologyPanel}>
      <PanelHead
        icon="waypoints"
        title={t("Traffic topology")}
        subtitle={
          totals.conns > 0
            ? t("{count} active connections from {sources} sources", { count: totals.conns, sources })
            : t("Hover a node to trace its paths")
        }
        actions={
          <>
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
          </>
        }
      />
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
        <TopologyDetail model={model} nodeKey={selected} groups={groups.data.groups} onClose={() => setSelected(null)} />
      )}
      {confirming && (
        <Dialog onClose={() => setConfirming(false)}>
          <h3>{t("Close all connections?")}</h3>
          <p className="dialog-message">{t("Every active connection will be closed. Applications reconnect on their own.")}</p>
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
    </Panel>
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

function TopologyDetail(props: { model: TopologyModel; nodeKey: string; groups: Group[]; onClose: () => void }) {
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
  const group = node.column === "group" ? props.groups.find((entry) => entry.tag === node.tag) : undefined;
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
              value={node.column === "inbound" ? inboundDisplayType(node.type) : proxyDisplayType(node.type)}
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
                  {nodeRate(member) > 0 ? rate(nodeRate(member)) : t("{count} connections", { count: member.conns })}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}
      {group && (
        <DetailSection title={`${proxyDisplayType(group.type)} · ${t("{count} nodes", { count: group.items.length })}`}>
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
                  <span className={cx("mono", styles.detailRate, item.urlTestDelay > 0 && styles[urlTestDelayTone(item.urlTestDelay)])}>
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
            onClick={() => navigate(filter === "" ? "connections" : `connections?q=${encodeURIComponent(filter)}`)}
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
              node.column !== "source" ? (process !== "" ? process : hostOf(connection.source)) : "",
              chain.join(" → "),
            ].filter((part) => part !== "");
            return (
              <div key={connection.id} className={styles.detailRow}>
                <span className={styles.detailMain}>
                  <span className={styles.detailTitle}>{connection.domain || connection.destination}</span>
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

/* ----------------------------------------------------------------- core */

function CorePanel() {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const current = status.data.current;
  const memory = status.data.memoryHistory;
  const goroutines = status.data.goroutineHistory;
  const [memoryValue, memoryUnit] = splitUnit(formatMemoryBytes(Number(current?.memory ?? 0)));
  const memoryPeak = memory.length > 0 ? formatMemoryBytes(Math.max(...memory)) : "—";

  return (
    <Panel span={4} className={styles.corePanel}>
      <PanelHead icon="memory" title={t("Core")} />
      <div className={styles.coreRows}>
        <div className={styles.coreRow}>
          <div className={styles.coreText}>
            <div className="metric-label">{t("Memory")}</div>
            <Metric value={current ? memoryValue : "—"} unit={current ? memoryUnit : undefined} size="medium" />
            <div className="metric-foot">
              {t("High")} <strong>{memoryPeak}</strong>
            </div>
          </div>
          <SmoothLine data={memory} capacity={STATUS_HISTORY_LENGTH} height={72} tone="ink" />
        </div>
        <div className={styles.coreRow}>
          <div className={styles.coreText}>
            <div className="metric-label">{t("Goroutines")}</div>
            <Metric value={current?.goroutines ?? "—"} size="medium" />
            <div className="metric-foot">
              {t("Low")} <strong>{goroutines.length > 0 ? Math.min(...goroutines) : "—"}</strong>
              {" · "}
              {t("High")} <strong>{goroutines.length > 0 ? Math.max(...goroutines) : "—"}</strong>
            </div>
          </div>
          <SmoothLine data={goroutines} capacity={STATUS_HISTORY_LENGTH} height={72} />
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------ providers */

function ProvidersSummaryPanel(props: { span: 6 | 12 }) {
  const api = useApi();
  const { t, language } = useI18n();
  const now = useNow(30_000);
  const providers = useStream(api.extended.providers);
  const list = providers.data.providers;

  return (
    <Panel span={props.span} className={styles.halfPanel}>
      <PanelHead
        icon="provider"
        title={t("Providers")}
        subtitle={t("{count} subscriptions", { count: list.length })}
        actions={
          <button type="button" className={styles.linkButton} onClick={() => navigate("providers")}>
            {t("Manage")}
            <Icon name="keyboard_arrow_right" size={14} />
          </button>
        }
      />
      {!providers.data.loaded ? (
        <EmptyState>{t("Loading...")}</EmptyState>
      ) : list.length === 0 ? (
        <EmptyState icon="provider">{t("No providers configured")}</EmptyState>
      ) : (
        <div className={styles.providerRows}>
          {list.map((provider) => {
            const info = provider.subscriptionInfo;
            const used = info ? Number(info.upload + info.download) : 0;
            const quota = info ? Number(info.total) : 0;
            const ratio = quota > 0 ? used / quota : 0;
            return (
              <div key={provider.tag} className={styles.providerRow}>
                <div className={styles.providerName}>
                  <span>{provider.tag}</span>
                  <span className="faint mono">{provider.items.length}</span>
                  {provider.lastError !== "" && <span className="badge danger">{t("Error")}</span>}
                </div>
                {quota > 0 ? (
                  <>
                    <Meter value={ratio} tone={ratio > 0.85 ? "warn" : undefined} />
                    <div className={cx("metric-foot", styles.providerFoot)}>
                      <span>
                        <strong>{formatBytes(used)}</strong> / {formatBytes(quota)}
                      </span>
                      {info && info.expireTime > 0n && (
                        <span>{t("Expires {time}", { time: formatRelativeTime(Number(info.expireTime) * 1000, now, language) })}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="metric-foot">
                    {provider.updatedAt > 0n
                      ? t("Updated {time}", { time: formatRelativeTime(Number(provider.updatedAt) * 1000, now, language) })
                      : t("Never updated")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ DNS */

const DAY_MS = 24 * 60 * 60 * 1000;

function DnsSummaryPanel(props: { span: 6 | 12 }) {
  const api = useApi();
  const { t, language } = useI18n();
  const cache = useExtension("dns_cache");
  // Loaded when the overview opens and on refresh, not polled: each load
  // reads a day of the query log.
  const { stats, loading, reload } = useDnsStats({ span: DAY_MS, bucket: 3600, top: 5, quiet: true });
  const [flushing, setFlushing] = useState(false);

  const total = Number(stats?.total ?? 0);
  // Only reject rules block; predefined answers count by status alone.
  const blocked = Number(stats?.statuses.rejected ?? 0n);
  const cached = Number(stats?.statuses.cached ?? 0n) + Number(stats?.statuses.optimistic ?? 0n);
  const buckets = stats?.buckets ?? [];
  const bucketMax = Math.max(...buckets.map((bucket) => Number(bucket.total)), 1);
  const average = Number(stats?.upstreamDuration?.average ?? 0n) / 1000;
  const [chartRef, chartWidth] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover !== null ? buckets[hover] : undefined;

  return (
    <Panel span={props.span} className={styles.halfPanel}>
      <PanelHead
        icon="dns"
        title="DNS"
        subtitle={t("24 hours")}
        actions={
          <>
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
            <Button size="small" disabled={loading} onClick={reload} aria-label={t("Refresh")} title={t("Refresh")}>
              {loading ? <Spinner /> : <Icon name="sync" size={13} />}
            </Button>
            <button type="button" className={styles.linkButton} onClick={() => navigate("dns")}>
              {t("Query log")}
              <Icon name="keyboard_arrow_right" size={14} />
            </button>
          </>
        }
      />
      <div className={styles.dnsStats}>
        <div>
          <div className="metric-label">{t("Queries")}</div>
          <Metric value={stats ? total.toLocaleString() : "—"} size="medium" />
        </div>
        <div>
          <div className="metric-label">{t("Blocked")}</div>
          <Metric
            value={stats ? blocked.toLocaleString() : "—"}
            unit={total > 0 ? `${((blocked / total) * 100).toFixed(1)}%` : undefined}
            size="medium"
          />
        </div>
        <div>
          <div className="metric-label">{t("From cache")}</div>
          <Metric
            value={stats ? (total > 0 ? ((cached / total) * 100).toFixed(1) : "0") : "—"}
            unit="%"
            size="medium"
          />
        </div>
        <div>
          <div className="metric-label">{t("Upstream avg")}</div>
          <Metric value={stats && average > 0 ? formatDurationMs(average).replace("ms", "") : "—"} unit={average > 0 && average < 1000 ? "ms" : undefined} size="medium" />
        </div>
      </div>
      <div className={styles.flexFill} />
      <div
        ref={chartRef}
        className={styles.dnsBars}
        role="img"
        aria-label={`${t("Queries")}: ${total.toLocaleString()}`}
        onPointerLeave={() => setHover(null)}
      >
        {buckets.map((bucket, index) => {
          const value = Number(bucket.total);
          const bucketBlocked = Number(bucket.statuses.rejected ?? 0n);
          return (
            <span
              key={String(bucket.time)}
              className={cx(styles.dnsBar, hover !== null && hover !== index && styles.dnsBarDimmed)}
              onPointerEnter={() => setHover(index)}
            >
              <span style={{ height: `${(value / bucketMax) * 100}%` }}>
                <span style={{ height: value > 0 ? `${(bucketBlocked / value) * 100}%` : 0 }} />
              </span>
            </span>
          );
        })}
        {hovered && hover !== null && chartWidth > 0 && (
          <BarTooltip index={hover} count={buckets.length} width={chartWidth}>
            <div className="tooltip-value">{Number(hovered.total).toLocaleString()}</div>
            <div className="tooltip-rows">
              <span>{t("Blocked")}</span>
              <span>
                {Number(hovered.statuses.rejected ?? 0n).toLocaleString()}
              </span>
            </div>
            <div className="tooltip-meta">
              {new Date(Number(hovered.time)).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}
            </div>
          </BarTooltip>
        )}
      </div>
      <div className={cx("metric-foot", styles.rangeFoot)}>
        <span>-24h</span>
        <span>{t("now")}</span>
      </div>
    </Panel>
  );
}
