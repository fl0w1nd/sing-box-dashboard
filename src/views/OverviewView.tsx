import { useEffect, useMemo, useState } from "react";

import {
  formatBytes,
  formatDurationMs,
  formatMemoryBytes,
  formatRelativeTime,
  LATENCY_GOOD_MS,
  LATENCY_MEDIUM_MS,
  proxyDisplayType,
  splitNodeTag,
  urlTestDelayTone,
} from "../api/format";
import { STATUS_HISTORY_LENGTH } from "../api/daemon";
import { useStream } from "../api/stream";
import { useExtension } from "../app/capabilities";
import { navigate, useApi, useNow } from "../app/context";
import { showError } from "../app/errorStore";
import { usePendingValue } from "../app/hooks";
import { useI18n } from "../app/i18n";
import { Board, Meter, Metric, Panel, PanelHead, Tabs } from "../components/Board";
import { LatencyScale, NodeStems, SmoothLine, TrafficStems, type StemNode } from "../components/charts";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamBanner } from "../components/StreamBanner";
import { Button, Dialog, EmptyState, Select, Spinner } from "../components/ui";
import type { DNSQueryLogStats } from "../gen/daemon/extended_service_pb";
import { ServiceStatus_Type, type Group } from "../gen/daemon/started_service_pb";
import { loadStoredString, saveStoredString } from "../lib/storage";
import { cx } from "../lib/cx";
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
  return (
    <Board>
      <TrafficPanel />
      <RoutePanel />
      <ConnectionsPanel span={providers ? 4 : 6} />
      <CorePanel span={providers ? 4 : 6} />
      {providers && <ProvidersSummaryPanel />}
      <LatencyPanel />
      {dnsLog && <DnsSummaryPanel />}
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
              labels={{ up: t("Upload"), down: t("Download"), now: t("now"), peak: t("peak") }}
            />
          ) : (
            <EmptyState icon="network_check">{t("Traffic statistics are not available")}</EmptyState>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- route */

const ROUTE_GROUP_KEY = "overview-route-group";

interface RouteStep {
  tag: string;
  detail: string;
  group: boolean;
  delay: number;
}

// The group an overview panel starts from when the user has not picked one:
// the first selector with a real choice, which is usually the main proxy
// group, then any group with members.
export function primaryGroup(groups: Group[]): Group | undefined {
  return (
    groups.find((group) => group.selectable && group.items.length > 1) ??
    groups.find((group) => group.items.length > 1) ??
    groups[0]
  );
}

function buildChain(groups: Group[], rootTag: string, nodes: (count: number) => string): RouteStep[] {
  const byTag = new Map(groups.map((group) => [group.tag, group]));
  const chain: RouteStep[] = [];
  const visited = new Set<string>();
  let tag = rootTag;
  let parent: Group | undefined;
  while (tag !== "" && !visited.has(tag)) {
    visited.add(tag);
    const group = byTag.get(tag);
    const item = parent?.items.find((entry) => entry.tag === tag);
    if (!group) {
      chain.push({
        tag,
        detail: item ? proxyDisplayType(item.type) : "",
        group: false,
        delay: item?.urlTestDelay ?? 0,
      });
      break;
    }
    chain.push({
      tag,
      detail: `${proxyDisplayType(group.type)} · ${nodes(group.items.length)}`,
      group: true,
      delay: item?.urlTestDelay ?? 0,
    });
    parent = group;
    tag = group.selected;
  }
  return chain;
}

function RoutePanel() {
  const api = useApi();
  const { t } = useI18n();
  const groups = useStream(api.groups);
  const clashMode = useStream(api.clashMode);
  const list = groups.data.groups;
  const [stored, setStored] = useState(() => loadStoredString(ROUTE_GROUP_KEY));
  const root = list.find((group) => group.tag === stored) ?? primaryGroup(list);
  const chain = useMemo(
    () => (root ? buildChain(list, root.tag, (count) => t("{count} nodes", { count })) : []),
    [list, root, t],
  );
  const last = chain[chain.length - 1];
  const delay = last && !last.group ? last.delay : 0;
  const tone = urlTestDelayTone(delay);
  const scaleMax = delay > 400 ? Math.ceil(delay / 200) * 200 : 400;

  return (
    <Panel span={4}>
      <PanelHead
        icon="route"
        title={t("Active route")}
        actions={clashMode.data.currentMode !== "" && <span className="badge outline">{clashMode.data.currentMode}</span>}
      />
      {list.length === 0 ? (
        <EmptyState icon="route">{t("Empty groups")}</EmptyState>
      ) : (
        <>
          <ol className={styles.chain}>
            {chain.map((step, index) => {
              const terminal = index === chain.length - 1;
              const split = splitNodeTag(step.tag);
              return (
                <li key={step.tag} className={cx(styles.chainStep, terminal && styles.chainActive)}>
                  <span className={styles.chainMarker} />
                  <div className={styles.chainText}>
                    {index === 0 && list.length > 1 ? (
                      <Select
                        inline
                        options={list.map((group) => ({ value: group.tag, label: group.tag }))}
                        value={step.tag}
                        onChange={(value) => {
                          saveStoredString(ROUTE_GROUP_KEY, value);
                          setStored(value);
                        }}
                      />
                    ) : (
                      <span className={styles.chainTitle}>
                        {split.flag !== "" && <span className={styles.flag}>{split.flag}</span>}
                        {split.name}
                      </span>
                    )}
                    <span className={styles.chainDetail}>
                      {split.prefix !== "" ? `${split.prefix} · ${step.detail}` : step.detail}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className={styles.latency}>
            <div className={styles.latencyHead}>
              <span className="secondary">{t("Latency")}</span>
              <Metric value={delay > 0 ? delay : "—"} unit="ms" size="medium" />
            </div>
            <LatencyScale delay={delay} max={scaleMax} tone={tone} />
          </div>
        </>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- core */

function CorePanel(props: { span: 4 | 6 }) {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const current = status.data.current;
  const memory = status.data.memoryHistory;
  const goroutines = status.data.goroutineHistory;
  const [memoryValue, memoryUnit] = splitUnit(formatMemoryBytes(Number(current?.memory ?? 0)));
  const memoryPeak = memory.length > 0 ? formatMemoryBytes(Math.max(...memory)) : "—";

  return (
    <Panel span={props.span}>
      <PanelHead icon="memory" title={t("Core")} subtitle={t("Memory and goroutines")} />
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

/* ---------------------------------------------------------- connections */

function ConnectionsPanel(props: { span: 4 | 6 }) {
  const api = useApi();
  const { t } = useI18n();
  const status = useStream(api.status);
  const [confirming, setConfirming] = useState(false);
  const inbound = status.data.current?.connectionsIn ?? 0;
  const outbound = status.data.current?.connectionsOut ?? 0;
  const total = inbound + outbound;
  const share = total > 0 ? inbound / total : 0.5;

  return (
    <Panel span={props.span}>
      <PanelHead
        icon="hub"
        title={t("Connections")}
        subtitle={t("Tracked right now")}
        actions={
          <button type="button" className={styles.linkButton} onClick={() => navigate("connections")}>
            {t("View all")}
            <Icon name="keyboard_arrow_right" size={14} />
          </button>
        }
      />
      <div className={styles.connectionsSplit}>
        <div>
          <div className="metric-label">
            <span className="swatch down" />
            {t("Inbound")}
          </div>
          <Metric value={status.data.current ? inbound : "—"} size="large" />
        </div>
        <div className={styles.connectionsDivider} />
        <div>
          <div className="metric-label">
            <span className="swatch up" />
            {t("Outbound")}
          </div>
          <Metric value={status.data.current ? outbound : "—"} size="large" />
        </div>
      </div>
      <div className={styles.flexFill} />
      <div className={styles.shareBar}>
        <span className={styles.shareIn} style={{ flexGrow: share }} />
        <span className={styles.shareOut} style={{ flexGrow: 1 - share }} />
      </div>
      <div className={styles.connectionsFoot}>
        <span className="metric-foot">{t("{percent}% inbound", { percent: (share * 100).toFixed(1) })}</span>
        <Button size="small" disabled={inbound === 0} onClick={() => setConfirming(true)}>
          {t("Close all")}
        </Button>
      </div>
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

/* -------------------------------------------------------------- latency */

const LATENCY_TAB_KEY = "overview-latency-group";
const LATENCY_STEM_LIMIT = 16;

function LatencyPanel() {
  const api = useApi();
  const { t } = useI18n();
  const groups = useStream(api.groups);
  const list = groups.data.groups;
  const [stored, setStored] = useState(() => loadStoredString(LATENCY_TAB_KEY) ?? "");
  const [testing, setTesting] = useState<string | null>(null);
  const group = list.find((entry) => entry.tag === stored) ?? primaryGroup(list);
  const [selected, setPendingSelection, switching] = usePendingValue(group?.selected ?? "");

  // Fastest first, untested last; the tail beyond the cap lives on the
  // groups page (the selected node always stays visible).
  const ranked = [...(group?.items ?? [])].sort(
    (a, b) => (a.urlTestDelay > 0 ? a.urlTestDelay : Infinity) - (b.urlTestDelay > 0 ? b.urlTestDelay : Infinity),
  );
  const shown = ranked.slice(0, LATENCY_STEM_LIMIT);
  const selectedItem = ranked.find((item) => item.tag === selected);
  if (selectedItem && !shown.includes(selectedItem)) {
    shown[shown.length - 1] = selectedItem;
  }
  const nodes: StemNode[] = shown.map((item) => {
    const split = splitNodeTag(item.tag);
    return {
      tag: item.tag,
      label: `${split.flag}${split.flag !== "" ? " " : ""}${split.name}`,
      delay: item.urlTestDelay,
      tone: urlTestDelayTone(item.urlTestDelay),
    };
  });

  const runTest = () => {
    if (!group) {
      return;
    }
    const tag = group.tag;
    setTesting(tag);
    api
      .urlTest(tag)
      .catch(showError)
      .finally(() => setTesting((current) => (current === tag ? null : current)));
  };

  return (
    <Panel>
      <PanelHead
        icon="speed"
        title={t("Node latency")}
        subtitle={group?.selectable ? t("Fastest first · click a stem to switch") : t("Fastest first · latest URL test")}
        actions={
          <>
            <div className={cx("legend", styles.latencyLegend)}>
              <span className="legend-item">
                <span className={cx(styles.legendDot, styles.legendGood)} />
                {`< ${LATENCY_GOOD_MS} ms`}
              </span>
              <span className="legend-item">
                <span className={cx(styles.legendDot, styles.legendMedium)} />
                {`${LATENCY_GOOD_MS}–${LATENCY_MEDIUM_MS}`}
              </span>
              <span className="legend-item">
                <span className={cx(styles.legendDot, styles.legendBad)} />
                {`> ${LATENCY_MEDIUM_MS}`}
              </span>
              <span className="legend-item">
                <span className={cx(styles.legendDot, styles.legendNone)} />
                {t("No result")}
              </span>
            </div>
            <Button className="accent" disabled={!group || testing === group.tag} onClick={runTest}>
              {testing !== null && testing === group?.tag ? <Spinner /> : <Icon name="bolt" />}
              {t("Test latency")}
            </Button>
          </>
        }
      />
      {list.length === 0 ? (
        <EmptyState icon="speed">{t("Empty groups")}</EmptyState>
      ) : (
        <>
          <Tabs
            options={list.map((entry) => ({ value: entry.tag, label: entry.tag, count: entry.items.length }))}
            value={group?.tag ?? ""}
            onChange={(value) => {
              saveStoredString(LATENCY_TAB_KEY, value);
              setStored(value);
            }}
          />
          <div className={styles.stemsWrap}>
            <NodeStems
              key={group?.tag}
              nodes={nodes}
              selected={selected}
              switching={switching}
              selectable={group?.selectable ?? false}
              more={{ count: ranked.length - nodes.length, label: t("On the groups page"), onOpen: () => navigate("groups") }}
              onSelect={(tag) => {
                if (!group?.selectable || tag === selected) {
                  return;
                }
                setPendingSelection(tag);
                api.selectOutbound(group.tag, tag).catch((error: unknown) => {
                  setPendingSelection(null);
                  showError(error);
                });
              }}
            />
          </div>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------ providers */

function ProvidersSummaryPanel() {
  const api = useApi();
  const { t, language } = useI18n();
  const now = useNow(30_000);
  const providers = useStream(api.extended.providers);
  const list = providers.data.providers;

  return (
    <Panel span={4}>
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

function DnsSummaryPanel() {
  const api = useApi();
  const { t } = useI18n();
  const cache = useExtension("dns_cache");
  const [stats, setStats] = useState<DNSQueryLogStats | null>(null);
  const [flushing, setFlushing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      api.extended
        .dnsLogStats({ since: Date.now() - DAY_MS }, 3600, 5, controller.signal)
        .then(setStats, () => {});
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api]);

  const total = Number(stats?.total ?? 0);
  const blocked = Number(stats?.statuses.rejected ?? 0n) + Number(stats?.statuses.predefined ?? 0n);
  const cached = Number(stats?.statuses.cached ?? 0n) + Number(stats?.statuses.optimistic ?? 0n);
  const buckets = stats?.buckets ?? [];
  const bucketMax = Math.max(...buckets.map((bucket) => Number(bucket.total)), 1);
  const average = Number(stats?.upstreamDuration?.average ?? 0n) / 1000;

  return (
    <Panel>
      <PanelHead
        icon="dns"
        title="DNS"
        subtitle={t("Queries in the last 24 hours")}
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
      <div className={styles.dnsBars} aria-hidden="true">
        {buckets.map((bucket) => {
          const value = Number(bucket.total);
          const bucketBlocked = Number(bucket.statuses.rejected ?? 0n) + Number(bucket.statuses.predefined ?? 0n);
          return (
            <span key={String(bucket.time)} className={styles.dnsBar} title={`${new Date(Number(bucket.time)).toLocaleTimeString()} · ${value}`}>
              <span style={{ height: `${(value / bucketMax) * 100}%` }}>
                <span style={{ height: value > 0 ? `${(bucketBlocked / value) * 100}%` : 0 }} />
              </span>
            </span>
          );
        })}
      </div>
      <div className={cx("metric-foot", styles.rangeFoot)}>
        <span>-24h</span>
        <span>{t("now")}</span>
      </div>
    </Panel>
  );
}
