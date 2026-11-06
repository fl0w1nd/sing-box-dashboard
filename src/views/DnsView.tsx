import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { DNSQueryFilter } from "../api/extended";
import { formatBytes, formatClockTime, formatDateTime } from "../api/format";
import { useExtension } from "../app/capabilities";
import { useApi } from "../app/context";
import { showError } from "../app/errorStore";
import { useUnaryOnce } from "../app/hooks";
import { useI18n, type Translate } from "../app/i18n";
import { useDnsStats } from "../app/useDnsStats";
import { Chips, IconTile } from "../components/Board";
import { useElementWidth } from "../components/charts";
import { Icon, type IconName } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  CopyValue,
  DataLine,
  DetailSection,
  DetailShell,
  Dialog,
  EmptyState,
  LoadingBar,
  LoadingDots,
  MenuItem,
  OthersMenu,
  SearchInput,
  Select,
  Spinner,
  type BadgeTone,
} from "../components/ui";
import type {
  DNSQueryLogEntry,
  DNSQueryLogStats,
  DNSQueryLogStatsBucket,
  DNSQueryLogStatsCount,
} from "../gen/daemon/extended_service_pb";
import { cx } from "../lib/cx";
import { hostOf } from "../lib/topology";
import styles from "./DnsView.module.css";

const PAGE_SIZE = 100;
// Live updates insert rows at the top, which makes the browser lay out and
// paint every row below again, so the live log keeps fewer rows; older ones
// are paged from the core.
const LIVE_MAX_ENTRIES = 200;

type Tab = "overview" | "log";
type Range = "1h" | "24h" | "7d";

const RANGES: Record<Range, { span: number; bucket: number }> = {
  "1h": { span: 3600_000, bucket: 120 },
  "24h": { span: 86_400_000, bucket: 3600 },
  "7d": { span: 7 * 86_400_000, bucket: 6 * 3600 },
};

const STATUSES = [
  "upstream",
  "cached",
  "optimistic",
  "fakeip",
  "rejected",
  "predefined",
  "strategy",
  "local",
  "error",
] as const;

const QUERY_TYPES = ["A", "AAAA", "HTTPS", "CNAME", "MX", "TXT", "SRV", "PTR", "NS", "SOA"];

const CACHED_KEYS = ["cached", "optimistic"];

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "cached":
    case "optimistic":
      return "info";
    case "rejected":
    case "predefined":
      return "bad";
    case "fakeip":
      return "accent";
    case "error":
      return "medium";
    default:
      return "neutral";
  }
}

function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case "upstream":
      return t("Upstream");
    case "cached":
      return t("Cached");
    case "optimistic":
      return t("Optimistic");
    case "fakeip":
      return "FakeIP";
    case "rejected":
      return t("Rejected");
    case "predefined":
      return t("Predefined");
    case "strategy":
      return t("Strategy");
    case "local":
      return t("Local");
    case "error":
      return t("Failed");
    default:
      return status;
  }
}

function methodLabel(method: string, t: Translate): string {
  switch (method) {
    case "exchange":
      return t("Exchange");
    case "lookup":
      return t("Lookup");
    case "background":
      return t("Background refresh");
    default:
      return method;
  }
}

// Durations in the log are microseconds.
function formatMicros(value: bigint | number): string {
  const micros = Number(value);
  if (micros <= 0) {
    return "0 ms";
  }
  const millis = micros / 1000;
  if (millis < 10) {
    return `${millis.toFixed(1)} ms`;
  }
  if (millis < 1000) {
    return `${Math.round(millis)} ms`;
  }
  return `${(millis / 1000).toFixed(2)} s`;
}

function durationTone(value: bigint | number, hasError: boolean): string | false {
  if (hasError) {
    return styles.warn;
  }
  const millis = Number(value) / 1000;
  if (millis >= 400) {
    return styles.warn;
  }
  if (millis >= 150) {
    return styles.slow;
  }
  return false;
}

function niceCeil(value: number): number {
  if (value <= 4) {
    return 4;
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
    return `M ${points[0].x} ${points[0].y}`;
  }
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[Math.max(index - 1, 0)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(index + 2, points.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return path;
}

function sumStatuses(statuses: Record<string, bigint> | undefined, keys: string[]): number {
  if (!statuses) {
    return 0;
  }
  return keys.reduce((sum, key) => sum + Number(statuses[key] ?? 0n), 0);
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function DnsView() {
  const api = useApi();
  const { t } = useI18n();
  const logSupported = useExtension("dns_query_log");
  const cacheSupported = useExtension("dns_cache");
  const [tab, setTab] = useState<Tab>("overview");
  const [flushing, setFlushing] = useState(false);
  const [flushed, setFlushed] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [generation, setGeneration] = useState(0);
  const status = useUnaryOnce(() => api.extended.dnsLogStatus(), logSupported);

  useEffect(() => {
    if (!flushed) {
      return;
    }
    const timer = setTimeout(() => setFlushed(false), 2200);
    return () => clearTimeout(timer);
  }, [flushed]);

  const flush = () => {
    setFlushing(true);
    api.extended
      .clearDnsCache()
      .then(() => setFlushed(true), showError)
      .finally(() => setFlushing(false));
  };

  const ready = logSupported && status !== null && status.enabled;

  return (
    <div className="page">
      <PageHeader
        title="DNS"
        actions={
          <>
            {ready && (
              <div className="segmented" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "overview"}
                  className={tab === "overview" ? "active" : ""}
                  onClick={() => setTab("overview")}
                >
                  {t("Overview")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "log"}
                  className={tab === "log" ? "active" : ""}
                  onClick={() => setTab("log")}
                >
                  {t("Query log")}
                </button>
              </div>
            )}
            {cacheSupported && (
              <Button disabled={flushing} onClick={flush}>
                {flushing ? <Spinner /> : <Icon name={flushed ? "check" : "eraser"} />}
                {flushed ? t("Cache flushed") : t("Flush DNS cache")}
              </Button>
            )}
            {ready && (
              <OthersMenu>
                <MenuItem icon="delete" danger onSelect={() => setConfirmClear(true)}>
                  {t("Clear query log")}
                </MenuItem>
              </OthersMenu>
            )}
          </>
        }
      />
      {!logSupported ? (
        <EmptyState icon="dns">{t("This core does not record DNS queries.")}</EmptyState>
      ) : status === null ? (
        <EmptyState>
          <LoadingDots />
        </EmptyState>
      ) : !status.enabled ? (
        <div className={styles.disabled}>
          <EmptyState icon="dns">
            <div className={styles.disabledTitle}>{t("The DNS query log is disabled")}</div>
            <div>{t("Enable it in the configuration of the core:")}</div>
            <pre className={styles.snippet}>{`"experimental": {\n  "dns_query_log": {\n    "enabled": true\n  }\n}`}</pre>
          </EmptyState>
        </div>
      ) : (
        <DnsContent
          key={generation}
          tab={tab}
          onTabChange={setTab}
          storage={
            status.persistent
              ? t("{size} on disk · {segments} segments", {
                  size: formatBytes(Number(status.diskUsage)),
                  segments: status.segments,
                })
              : t("In memory · {count} entries", { count: status.memoryEntries })
          }
        />
      )}
      {confirmClear && (
        <Dialog onClose={() => setConfirmClear(false)}>
          <h3>{t("Clear query log?")}</h3>
          <p className="dialog-message">{t("All recorded DNS queries are removed, in memory and on disk.")}</p>
          <div className="row-actions dialog-actions">
            <Button onClick={() => setConfirmClear(false)}>{t("Cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                api.extended
                  .clearDnsLog()
                  .then(() => setGeneration((value) => value + 1), showError);
              }}
            >
              {t("Clear")}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function DnsContent(props: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  storage: string;
}) {
  const [range, setRange] = useState<Range>("24h");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [serverFilter, setServerFilter] = useState("");
  const [methodFilter, setMethodFilter] = useState("");
  const { stats, loading: statsLoading, updated, reload } = useDnsStats({ ...RANGES[range], top: 8 });

  const openLogWith = (next: {
    search?: string;
    status?: string;
    queryType?: string;
    server?: string;
    method?: string;
  }) => {
    setSearch(next.search ?? "");
    setStatusFilter(next.status ?? "");
    setTypeFilter(next.queryType ?? "");
    setServerFilter(next.server ?? "");
    setMethodFilter(next.method ?? "");
    props.onTabChange("log");
  };

  const servers = useMemo(
    () => (stats?.upstreams ?? []).map((upstream) => upstream.server).filter((value, index, list) => list.indexOf(value) === index),
    [stats],
  );

  if (props.tab === "log") {
    return (
      <QueryLog
        filter={{ search, status: statusFilter, method: methodFilter, queryType: typeFilter, server: serverFilter }}
        servers={servers}
        storage={props.storage}
        onSearch={setSearch}
        onStatus={setStatusFilter}
        onMethod={setMethodFilter}
        onType={setTypeFilter}
        onServer={setServerFilter}
      />
    );
  }

  return (
    <OverviewTab
      stats={stats}
      loading={statsLoading}
      updated={updated}
      storage={props.storage}
      range={range}
      onRange={setRange}
      onReload={reload}
      onOpenLog={openLogWith}
    />
  );
}

/* ------------------------------------------------------------ overview tab */

function OverviewTab(props: {
  stats: DNSQueryLogStats | null;
  loading: boolean;
  updated: number | null;
  storage: string;
  range: Range;
  onRange: (range: Range) => void;
  onReload: () => void;
  onOpenLog: (filter: {
    search?: string;
    status?: string;
    queryType?: string;
    server?: string;
    method?: string;
  }) => void;
}) {
  const { t } = useI18n();
  const stats = props.stats;
  const total = Number(stats?.total ?? 0);
  const blocked = sumStatuses(stats?.statuses, ["rejected"]);
  const predefined = sumStatuses(stats?.statuses, ["predefined"]);
  const strictCached = sumStatuses(stats?.statuses, ["cached"]);
  const optimistic = sumStatuses(stats?.statuses, ["optimistic"]);
  const cached = strictCached + optimistic;
  const failed = sumStatuses(stats?.statuses, ["error"]);
  const clientCount = Number(stats?.methods.exchange ?? 0n);
  const internalCount = Math.max(0, total - clientCount);
  const buckets = useMemo(() => stats?.buckets ?? [], [stats]);
  const percent = (value: number) => (total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%");

  const totalSeries = useMemo(() => buckets.map((b) => Number(b.total)), [buckets]);
  const cachedSeries = useMemo(() => buckets.map((b) => sumStatuses(b.statuses, CACHED_KEYS)), [buckets]);
  const blockedSeries = useMemo(() => buckets.map((b) => sumStatuses(b.statuses, ["rejected"])), [buckets]);
  const upstreamSeries = useMemo(
    () =>
      buckets.map((b) => {
        const tot = Number(b.total);
        const c = sumStatuses(b.statuses, CACHED_KEYS);
        const r = sumStatuses(b.statuses, ["rejected"]);
        return Math.max(0, tot - c - r);
      }),
    [buckets],
  );

  const initialLoading = stats === null && props.loading;
  const avgDuration = stats
    ? stats.upstreamDuration
      ? formatMicros(stats.upstreamDuration.average)
      : "—"
    : initialLoading
      ? <LoadingDots />
      : "—";
  const p95Duration = stats?.upstreamDuration ? formatMicros(stats.upstreamDuration.p95) : "—";

  return (
    <div className={cx(styles.overview, props.loading && stats !== null && "busy-dim")}>
      <div className={styles.controlBar}>
        <Chips
          options={[
            { value: "1h", label: t("1 hour") },
            { value: "24h", label: t("24 hours") },
            { value: "7d", label: t("7 days") },
          ]}
          value={props.range}
          onChange={props.onRange}
        />
        <div className={styles.controlMeta}>
          <span className="faint mono">{props.storage}</span>
          {props.updated !== null && (
            <span className="faint">{t("Updated {time}", { time: formatClockTime(props.updated) })}</span>
          )}
          <Button size="small" disabled={props.loading} onClick={props.onReload}>
            {props.loading ? <Spinner /> : <Icon name="sync" size={13} />}
            {t("Refresh")}
          </Button>
        </div>
      </div>

      {/* Row 1: 4 AdGuard-Home-style KPI Sparkline Cards */}
      <div className={styles.kpiGrid}>
        <KpiCard
          label={t("Queries")}
          badge={stats ? `${percent(clientCount)} ${t("Client")}` : undefined}
          value={stats ? total.toLocaleString() : initialLoading ? <LoadingDots /> : "—"}
          foot={
            stats
              ? t("Clients {client} · internal {internal}", {
                  client: clientCount.toLocaleString(),
                  internal: internalCount.toLocaleString(),
                })
              : initialLoading
                ? ""
                : "—"
          }
          series={totalSeries}
          tone="ink"
          onClick={() => props.onOpenLog({})}
        />
        <KpiCard
          label={t("From cache")}
          badge={stats ? percent(cached) : undefined}
          badgeTone="info"
          value={stats ? cached.toLocaleString() : initialLoading ? <LoadingDots /> : "—"}
          foot={
            stats
              ? `${t("Cached")} ${strictCached.toLocaleString()} · ${t("Optimistic")} ${optimistic.toLocaleString()}`
              : initialLoading
                ? ""
                : "—"
          }
          series={cachedSeries}
          tone="cobalt"
          onClick={() => props.onOpenLog({ status: "cached" })}
        />
        <KpiCard
          label={t("Blocked")}
          badge={stats ? percent(blocked) : undefined}
          badgeTone={blocked > 0 ? "bad" : "neutral"}
          value={stats ? blocked.toLocaleString() : initialLoading ? <LoadingDots /> : "—"}
          foot={
            stats
              ? `${t("Rejected")} ${blocked.toLocaleString()} · ${t("Predefined")} ${predefined.toLocaleString()}`
              : initialLoading
                ? ""
                : "—"
          }
          series={blockedSeries}
          tone="bad"
          onClick={() => props.onOpenLog({ status: "rejected" })}
        />
        <KpiCard
          label={t("Upstream latency")}
          badge={stats?.upstreamDuration ? `P95 ${p95Duration}` : undefined}
          badgeTone={failed > 0 ? "medium" : "good"}
          value={avgDuration}
          foot={
            stats
              ? `${t("Failed")} ${failed.toLocaleString()} (${percent(failed)})`
              : initialLoading
                ? ""
                : "—"
          }
          series={upstreamSeries}
          tone="good"
          onClick={() => props.onOpenLog({ status: "upstream" })}
        />
      </div>

      {/* Row 2: Fixed-height SVG Area Timeline + Query Type / Status Distribution */}
      <div className={styles.analyticsRow}>
        <TrendCard buckets={buckets} total={total} loading={initialLoading} />
        <DistributionCard
          stats={stats}
          total={total}
          loading={initialLoading}
          onPickType={(queryType) => props.onOpenLog({ queryType })}
          onPickStatus={(status) => props.onOpenLog({ status })}
        />
      </div>

      {/* Row 3: 3 Ranking Cards */}
      <div className={styles.rankGrid}>
        <DomainsCard
          stats={stats}
          loading={initialLoading}
          onPick={(domain) => props.onOpenLog({ search: domain })}
        />
        <BlockedCard
          stats={stats}
          loading={initialLoading}
          onPickDomain={(domain) => props.onOpenLog({ search: domain })}
          onPickRule={() => props.onOpenLog({ status: "rejected" })}
        />
        <RankCard
          icon="computer"
          title={t("Top clients")}
          loading={initialLoading}
          items={countItems(stats?.topClients ?? [], (client) => props.onOpenLog({ search: client }))}
        />
      </div>

      {/* Row 4: Multi-column Upstream Resolvers Grid */}
      <UpstreamsSection
        stats={stats}
        onPick={(server) => props.onOpenLog({ server })}
      />
    </div>
  );
}

type SparkTone = "ink" | "cobalt" | "bad" | "good";

const KPI_TONE_CLASS: Record<SparkTone, string> = {
  ink: styles.kpiInk,
  cobalt: styles.kpiCobalt,
  bad: styles.kpiBad,
  good: styles.kpiGood,
};

function KpiCard(props: {
  label: string;
  badge?: string;
  badgeTone?: BadgeTone;
  value: ReactNode;
  foot: ReactNode;
  series: number[];
  tone: SparkTone;
  onClick: () => void;
}) {
  const width = 260;
  const height = 42;
  const data = props.series;
  const max = Math.max(...data, 1);
  const hasSignal = data.some((v) => v > 0);
  const points = data.map((val, index) => ({
    x: data.length > 1 ? (index / (data.length - 1)) * width : width / 2,
    y: hasSignal ? height - 3 - (val / max) * (height - 10) : height - 3,
  }));
  const strokePath = smoothLinePath(points);
  const areaPath =
    points.length > 1
      ? `${strokePath} L ${points[points.length - 1].x.toFixed(1)} ${height} L ${points[0].x.toFixed(1)} ${height} Z`
      : "";

  return (
    <button type="button" className={cx(styles.kpiCard, KPI_TONE_CLASS[props.tone])} onClick={props.onClick}>
      <div className={styles.kpiTop}>
        <span className={styles.kpiLabel}>{props.label}</span>
        {props.badge && <Badge tone={props.badgeTone}>{props.badge}</Badge>}
      </div>
      <div className={styles.kpiValue}>{props.value}</div>
      <div className={styles.kpiFoot}>{props.foot}</div>
      <div className={styles.kpiSpark} aria-hidden="true">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
          {areaPath !== "" && <path d={areaPath} className={styles.kpiSparkArea} />}
          {strokePath !== "" && <path d={strokePath} className={styles.kpiSparkLine} />}
        </svg>
      </div>
    </button>
  );
}

function TrendCard(props: { buckets: DNSQueryLogStatsBucket[]; total: number; loading?: boolean }) {
  const { t, language } = useI18n();
  const buckets = props.buckets;
  const [chartRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const height = 228;
  const axisBottom = 22;
  const padTop = 10;
  const padX = 8;
  const plotHeight = height - axisBottom;

  const rawMax = Math.max(...buckets.map((b) => Number(b.total)), 1);
  const scaleMax = niceCeil(rawMax);
  const count = buckets.length;
  const step = count > 1 && width > 0 ? (width - padX * 2) / (count - 1) : 0;

  const xAt = (index: number) => padX + index * step;
  const yAt = (value: number) => padTop + (1 - Math.min(value, scaleMax) / scaleMax) * (plotHeight - padTop);

  const totalPoints = useMemo(
    () => buckets.map((b, i) => ({ x: padX + i * step, y: yAt(Number(b.total)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, step, scaleMax],
  );
  const cachedPoints = useMemo(
    () => buckets.map((b, i) => ({ x: padX + i * step, y: yAt(sumStatuses(b.statuses, CACHED_KEYS)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, step, scaleMax],
  );
  const blockedPoints = useMemo(
    () => buckets.map((b, i) => ({ x: padX + i * step, y: yAt(sumStatuses(b.statuses, ["rejected", "error"])) })),
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

  const tickIndices = useMemo(() => {
    if (count < 2) {
      return [];
    }
    const steps = Math.min(4, count - 1);
    return Array.from({ length: steps + 1 }, (_, i) => Math.round((i / steps) * (count - 1)));
  }, [count]);

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon="chart" small />
        <span className={styles.cardTitle}>{t("Query trend")}</span>
        <div className={styles.trendLegend}>
          <span className={styles.legendItem}>
            <span className={cx(styles.key, styles.keyTotal)} />
            {t("Queries")}
          </span>
          <span className={styles.legendItem}>
            <span className={cx(styles.key, styles.keyCached)} />
            {t("From cache")}
          </span>
          <span className={styles.legendItem}>
            <span className={cx(styles.key, styles.keyBlocked)} />
            {t("Blocked")}
          </span>
        </div>
      </header>
      <div
        ref={chartRef}
        className={styles.trendChart}
        style={{ height }}
        role="img"
        aria-label={`${t("Queries")}: ${props.total.toLocaleString()}`}
        onPointerMove={(event) => {
          if (step <= 0 || count === 0) {
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const index = Math.round((event.clientX - rect.left - padX) / step);
          setHover(Math.max(0, Math.min(count - 1, index)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {width > 0 && count > 1 ? (
          <>
            <svg className={styles.trendSvg} width={width} height={height} aria-hidden="true">
              {/* Grid lines */}
              {[0, 0.5, 1].map((ratio) => {
                const y = Math.round(padTop + ratio * (plotHeight - padTop)) + 0.5;
                return (
                  <line
                    key={ratio}
                    x1={padX}
                    x2={width - padX}
                    y1={y}
                    y2={y}
                    className={ratio === 1 ? styles.gridBaseline : styles.gridLine}
                  />
                );
              })}

              {/* Series areas & lines */}
              <path d={areaFor(totalPoints)} className={styles.areaTotal} />
              <path d={smoothLinePath(totalPoints)} className={styles.lineTotal} />

              <path d={areaFor(cachedPoints)} className={styles.areaCached} />
              <path d={smoothLinePath(cachedPoints)} className={styles.lineCached} />

              <path d={areaFor(blockedPoints)} className={styles.areaBlocked} />
              <path d={smoothLinePath(blockedPoints)} className={styles.lineBlocked} />

              {/* Hover crosshair and dots */}
              {hoveredIndex !== null && (
                <g>
                  <line
                    x1={xAt(hoveredIndex)}
                    x2={xAt(hoveredIndex)}
                    y1={padTop}
                    y2={plotHeight}
                    className={styles.hoverGuide}
                  />
                  <circle
                    cx={totalPoints[hoveredIndex].x}
                    cy={totalPoints[hoveredIndex].y}
                    r={3.5}
                    className={styles.dotTotal}
                  />
                  <circle
                    cx={cachedPoints[hoveredIndex].x}
                    cy={cachedPoints[hoveredIndex].y}
                    r={3.5}
                    className={styles.dotCached}
                  />
                  <circle
                    cx={blockedPoints[hoveredIndex].x}
                    cy={blockedPoints[hoveredIndex].y}
                    r={3.5}
                    className={styles.dotBlocked}
                  />
                </g>
              )}

              {/* X-axis labels */}
              {tickIndices.map((idx, pos) => {
                const bucket = buckets[idx];
                if (!bucket) {
                  return null;
                }
                const label =
                  pos === tickIndices.length - 1
                    ? t("now")
                    : new Date(Number(bucket.time)).toLocaleTimeString(language, {
                        hour: "2-digit",
                        minute: "2-digit",
                      });
                return (
                  <text
                    key={idx}
                    x={xAt(idx)}
                    y={height - 4}
                    textAnchor={pos === 0 ? "start" : pos === tickIndices.length - 1 ? "end" : "middle"}
                    className={styles.axisLabel}
                  >
                    {label}
                  </text>
                );
              })}
            </svg>
            <span className={styles.yLabelTop}>{scaleMax.toLocaleString()}</span>
            <span className={styles.yLabelMid}>{Math.round(scaleMax / 2).toLocaleString()}</span>
            {hoveredBucket && hoveredIndex !== null && (
              <div
                className={cx("tooltip-card", styles.trendTooltip)}
                style={{
                  left: Math.min(Math.max(xAt(hoveredIndex) - 70, 8), Math.max(width - 168, 8)),
                  top: 8,
                }}
              >
                <div className="tooltip-value">{Number(hoveredBucket.total).toLocaleString()}</div>
                <div className="tooltip-rows">
                  <span>{t("From cache")}</span>
                  <span>{sumStatuses(hoveredBucket.statuses, CACHED_KEYS).toLocaleString()}</span>
                  <span>{t("Blocked")}</span>
                  <span>{sumStatuses(hoveredBucket.statuses, ["rejected"]).toLocaleString()}</span>
                  <span>{t("Failed")}</span>
                  <span>{sumStatuses(hoveredBucket.statuses, ["error"]).toLocaleString()}</span>
                </div>
                <div className="tooltip-meta">{formatDateTime(Number(hoveredBucket.time), language)}</div>
              </div>
            )}
          </>
        ) : (
          <div className={styles.topEmpty}>{props.loading ? <LoadingDots /> : t("No data yet")}</div>
        )}
      </div>
    </section>
  );
}

const TYPE_TONES = [
  styles.typeColor0,
  styles.typeColor1,
  styles.typeColor2,
  styles.typeColor3,
  styles.typeColor4,
];

function DistributionCard(props: {
  stats: DNSQueryLogStats | null;
  total: number;
  loading?: boolean;
  onPickType: (queryType: string) => void;
  onPickStatus: (status: string) => void;
}) {
  const { t } = useI18n();
  const queryTypes = (props.stats?.queryTypes ?? []).slice(0, 5);
  const typeTotal = queryTypes.reduce((sum, item) => sum + Number(item.count), 0);

  const statuses = useMemo(() => {
    const map = props.stats?.statuses;
    if (!map) {
      return [];
    }
    return STATUSES.map((status) => ({
      status,
      count: Number(map[status] ?? 0n),
    })).filter((item) => item.count > 0);
  }, [props.stats]);

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon="dns" small />
        <span className={styles.cardTitle}>{t("Query types")}</span>
      </header>
      {queryTypes.length === 0 ? (
        <div className={styles.topEmpty}>{props.loading ? <LoadingDots /> : t("No data yet")}</div>
      ) : (
        <>
          <div className={styles.typeBar} aria-hidden="true">
            {queryTypes.map((item, index) => {
              const count = Number(item.count);
              return (
                count > 0 && (
                  <span
                    key={item.key}
                    className={TYPE_TONES[index % TYPE_TONES.length]}
                    style={{ flexGrow: count }}
                  />
                )
              );
            })}
          </div>
          <div className={styles.typeGrid}>
            {queryTypes.map((item, index) => {
              const count = Number(item.count);
              const pct = typeTotal > 0 ? `${((count / typeTotal) * 100).toFixed(1)}%` : "0%";
              return (
                <button
                  key={item.key}
                  type="button"
                  className={styles.typeItem}
                  onClick={() => props.onPickType(item.key)}
                >
                  <span className={cx(styles.key, TYPE_TONES[index % TYPE_TONES.length])} />
                  <span className={styles.typeName}>{item.key}</span>
                  <span className={styles.typePct}>{pct}</span>
                  <span className={styles.typeCount}>{count.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {statuses.length > 0 && (
        <div className={styles.statusSection}>
          <div className={styles.subHead}>{t("Status")}</div>
          <div className={styles.statusPills}>
            {statuses.map(({ status, count }) => (
              <button
                key={status}
                type="button"
                className={styles.statusPill}
                onClick={() => props.onPickStatus(status)}
              >
                <Badge tone={statusTone(status)}>{statusLabel(status, t)}</Badge>
                <span className={styles.statusPillCount}>{count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ rankings */

interface TopItem {
  key: string;
  rank?: string;
  label: ReactNode;
  title: string;
  count: number;
  onPick: () => void;
}

function countItems(counts: DNSQueryLogStatsCount[], onPick: (key: string) => void): TopItem[] {
  return counts.map((item) => ({
    key: item.key,
    label: item.key,
    title: item.key,
    count: Number(item.count),
    onPick: () => onPick(item.key),
  }));
}

function RankCard(props: {
  icon: IconName;
  title: string;
  items: TopItem[];
  loading?: boolean;
  tone?: "bad";
  empty?: string;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<number | null>(null);
  const max = Math.max(...props.items.map((item) => item.count), 1);
  const sum = props.items.reduce((acc, item) => acc + item.count, 0);

  useEffect(
    () => () => {
      if (scrollTimer.current !== null) {
        window.clearTimeout(scrollTimer.current);
      }
    },
    [],
  );

  const handleScroll = () => {
    setScrolling(true);
    if (scrollTimer.current !== null) {
      window.clearTimeout(scrollTimer.current);
    }
    scrollTimer.current = window.setTimeout(() => {
      setScrolling(false);
      scrollTimer.current = null;
    }, 750);
  };

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon={props.icon} small />
        <span className={styles.cardTitle}>{props.title}</span>
        {props.actions && <div className={styles.cardActions}>{props.actions}</div>}
      </header>
      {props.items.length === 0 ? (
        <div className={styles.topEmpty}>
          {props.loading ? <LoadingDots /> : (props.empty ?? t("No data yet"))}
        </div>
      ) : (
        <ol
          className={cx(styles.rankList, scrolling && styles.scrolling)}
          onScroll={handleScroll}
        >
          {props.items.map((item, index) => {
            const share = sum > 0 ? `${((item.count / sum) * 100).toFixed(0)}%` : "";
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className={styles.rankRow}
                  onClick={item.onPick}
                  title={item.title}
                >
                  <span
                    className={cx(styles.rankFill, props.tone === "bad" && styles.rankFillBad)}
                    style={{ width: `${(item.count / max) * 100}%` }}
                    aria-hidden="true"
                  />
                  <span className={styles.rankIndex}>
                    {item.rank ?? String(index + 1).padStart(2, "0")}
                  </span>
                  <span className={styles.rankKey}>{item.label}</span>
                  {share !== "" && <span className={styles.rankShare}>{share}</span>}
                  <span className={styles.rankCount}>{item.count.toLocaleString()}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {props.footer}
    </section>
  );
}

type DomainSource = "client" | "internal";

function DomainsCard(props: {
  stats: DNSQueryLogStats | null;
  loading?: boolean;
  onPick: (key: string) => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<DomainSource>("client");
  const internal = source === "internal";
  const counts = (internal ? props.stats?.topInternalDomains : props.stats?.topDomains) ?? [];
  const reverseCount = Number((internal ? props.stats?.internalReverseQueries : props.stats?.reverseQueries) ?? 0n);
  return (
    <RankCard
      icon="dns"
      title={t("Top domains")}
      loading={props.loading}
      items={countItems(counts, props.onPick)}
      footer={
        reverseCount > 0 && (
          <button type="button" className={styles.topFoot} onClick={() => props.onPick(".arpa")}>
            {t("{count} reverse lookups not ranked", { count: reverseCount.toLocaleString() })}
          </button>
        )
      }
      actions={
        <Chips
          className={styles.panelSwitch}
          options={[
            { value: "client", label: t("Client") },
            { value: "internal", label: t("Internal") },
          ]}
          value={source}
          onChange={setSource}
        />
      }
    />
  );
}

type BlockedView = "domains" | "rules";

function BlockedCard(props: {
  stats: DNSQueryLogStats | null;
  loading?: boolean;
  onPickDomain: (key: string) => void;
  onPickRule: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<BlockedView>("domains");
  const rules = props.stats?.topBlockedRules ?? [];
  const byRule = view === "rules";
  const items: TopItem[] = byRule
    ? rules.map((rule) => ({
        key: `${rule.rule}\u0000${rule.action}`,
        rank: `#${rule.index}`,
        label: (
          <>
            {rule.rule}
            <span className="faint"> → {rule.action}</span>
          </>
        ),
        title: `#${rule.index} ${rule.rule} → ${rule.action}`,
        count: Number(rule.count),
        onPick: props.onPickRule,
      }))
    : countItems(props.stats?.topBlockedDomains ?? [], props.onPickDomain);
  return (
    <RankCard
      icon="direct_off"
      title={t("Top blocked")}
      loading={props.loading}
      items={items}
      tone="bad"
      empty={t("Nothing blocked")}
      actions={
        <Chips
          className={styles.panelSwitch}
          options={[
            { value: "domains", label: t("Domain") },
            { value: "rules", label: t("Rule") },
          ]}
          value={view}
          onChange={setView}
        />
      }
    />
  );
}

/* ------------------------------------------------------------ upstreams */

function UpstreamsSection(props: {
  stats: DNSQueryLogStats | null;
  onPick: (server: string) => void;
}) {
  const { t } = useI18n();
  const upstreams = props.stats?.upstreams ?? [];
  if (upstreams.length === 0) {
    return null;
  }
  const totalExchanges = upstreams.reduce((sum, u) => sum + Number(u.exchanges), 0);

  return (
    <section className={styles.surfaceCard}>
      <header className={styles.cardHead}>
        <IconTile icon="waypoints" small />
        <span className={styles.cardTitle}>{t("Upstream servers")}</span>
        <span className="faint mono">{upstreams.length}</span>
      </header>
      <div className={styles.upstreamGrid}>
        {upstreams.map((upstream) => {
          const exchanges = Number(upstream.exchanges);
          const failed = Number(upstream.failed);
          const failRatio = exchanges > 0 ? failed / exchanges : 0;
          const share = totalExchanges > 0 ? (exchanges / totalExchanges) * 100 : 0;
          const healthTone = failRatio >= 0.1 ? "bad" : failRatio > 0 ? "medium" : "good";

          return (
            <button
              key={`${upstream.server}/${upstream.address}`}
              type="button"
              className={styles.upstreamCard}
              onClick={() => props.onPick(upstream.server)}
            >
              <div className={styles.upstreamTop}>
                <span className={cx("state-dot", healthTone)} />
                <span className={styles.serverName}>{upstream.server}</span>
                {upstream.type !== "" && <Badge>{upstream.type}</Badge>}
                <span className={styles.upstreamShare}>{share.toFixed(0)}%</span>
              </div>
              <div className={styles.upstreamAddr} title={upstream.address || upstream.detour}>
                {upstream.address !== "" ? (
                  <>
                    {upstream.address}
                    {upstream.detour !== "" && <span className="faint"> → {upstream.detour}</span>}
                  </>
                ) : (
                  upstream.detour || "—"
                )}
              </div>
              <div className={styles.upstreamStats}>
                <div>
                  <span className={styles.upstreamStatLabel}>{t("Exchanges")}</span>
                  <span className={styles.upstreamStatValue}>{exchanges.toLocaleString()}</span>
                </div>
                <div>
                  <span className={styles.upstreamStatLabel}>{t("Average")}</span>
                  <span className={styles.upstreamStatValue}>
                    {upstream.duration ? formatMicros(upstream.duration.average) : "—"}
                  </span>
                </div>
                <div>
                  <span className={styles.upstreamStatLabel}>P95</span>
                  <span className={styles.upstreamStatValue}>
                    {upstream.duration ? formatMicros(upstream.duration.p95) : "—"}
                  </span>
                </div>
                <div>
                  <span className={styles.upstreamStatLabel}>{t("Failed")}</span>
                  <span className={cx(styles.upstreamStatValue, failed > 0 && styles.warn)}>
                    {failed > 0 ? `${failed.toLocaleString()} (${Math.round(failRatio * 100)}%)` : "0"}
                  </span>
                </div>
              </div>
              <div className={styles.upstreamBar} aria-hidden="true">
                <span
                  className={styles.upstreamBarFill}
                  style={{ width: `${share > 0 ? Math.max(share, 2) : 0}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ query log */

interface LogPage {
  entries: DNSQueryLogEntry[];
  // The cursor of the next page, or zero when there is none: the ID of the
  // oldest entry shown, since the core pages by it.
  next: bigint;
}

function useQueryLog(filter: DNSQueryFilter, live: boolean, hold: boolean) {
  const api = useApi();
  const [log, setLog] = useState<LogPage>({ entries: [], next: 0n });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const heldRef = useRef<DNSQueryLogEntry[]>([]);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const key = JSON.stringify(filter);

  const commitEntries = (fresh: DNSQueryLogEntry[]) => {
    if (fresh.length === 0) {
      return;
    }
    setLog((current) => {
      const seen = new Set(current.entries.map((item) => item.id));
      const merged = fresh.filter((item) => !seen.has(item.id)).concat(current.entries);
      if (merged.length <= LIVE_MAX_ENTRIES) {
        return { entries: merged, next: current.next };
      }
      // The dropped entries are paged again from the oldest kept.
      const kept = merged.slice(0, LIVE_MAX_ENTRIES);
      return { entries: kept, next: kept[kept.length - 1].id };
    });
  };

  useEffect(() => {
    if (!hold && heldRef.current.length > 0) {
      const pending = heldRef.current;
      heldRef.current = [];
      setPendingCount(0);
      commitEntries(pending);
    }
  }, [hold]);

  useEffect(() => {
    const controller = new AbortController();
    heldRef.current = [];
    setPendingCount(0);
    setLoading(true);
    api.extended
      .queryDnsLog(filter, 0n, PAGE_SIZE, controller.signal)
      .then(
        (page) => setLog({ entries: page.entries, next: page.next }),
        (error: unknown) => {
          if (!controller.signal.aborted) {
            showError(error);
          }
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  useEffect(() => {
    if (!live) {
      heldRef.current = [];
      setPendingCount(0);
      return;
    }
    const controller = new AbortController();
    let buffer: DNSQueryLogEntry[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      for await (const entry of api.extended.followDnsLog(filter, controller.signal)) {
        buffer.push(entry);
        if (flush === null) {
          flush = setTimeout(() => {
            flush = null;
            const fresh = buffer.reverse();
            buffer = [];
            if (holdRef.current) {
              heldRef.current = fresh.concat(heldRef.current).slice(0, LIVE_MAX_ENTRIES);
              setPendingCount(heldRef.current.length);
              return;
            }
            commitEntries(fresh);
          }, 400);
        }
      }
    };
    run().catch(() => {});
    return () => {
      controller.abort();
      if (flush !== null) {
        clearTimeout(flush);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, live]);

  const loadMore = () => {
    const cursor = log.next;
    if (cursor === 0n || loadingMore) {
      return;
    }
    setLoadingMore(true);
    api.extended
      .queryDnsLog(filter, cursor, PAGE_SIZE)
      .then((page) => {
        setLog((current) => {
          // Live updates dropped entries meanwhile; the page would leave a gap.
          if (current.next !== cursor) {
            return current;
          }
          const seen = new Set(current.entries.map((item) => item.id));
          return {
            entries: current.entries.concat(page.entries.filter((item) => !seen.has(item.id))),
            next: page.next,
          };
        });
      }, showError)
      .finally(() => setLoadingMore(false));
  };

  return {
    entries: log.entries,
    loading,
    hasMore: log.next !== 0n,
    loadingMore,
    loadMore,
    pendingCount,
  };
}

function QueryLog(props: {
  filter: DNSQueryFilter;
  servers: string[];
  storage: string;
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onMethod: (value: string) => void;
  onType: (value: string) => void;
  onServer: (value: string) => void;
}) {
  const { t } = useI18n();
  const [live, setLive] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [selected, setSelected] = useState<DNSQueryLogEntry | null>(null);
  const [searchInput, setSearchInput] = useState(props.filter.search ?? "");
  const debouncedSearch = useDebounced(searchInput, 300);
  const { onSearch } = props;

  useEffect(() => {
    setSearchInput(props.filter.search ?? "");
  }, [props.filter.search]);

  useEffect(() => {
    onSearch(debouncedSearch);
  }, [debouncedSearch, onSearch]);

  const log = useQueryLog(props.filter, live, hovering);
  const typing = searchInput.trim() !== (props.filter.search ?? "").trim();
  const busy = log.loading || typing;

  const hasActiveFilters = Boolean(
    searchInput.trim() !== "" ||
      props.filter.status ||
      props.filter.method ||
      props.filter.queryType ||
      props.filter.server,
  );

  const resetFilters = () => {
    setSearchInput("");
    props.onSearch("");
    props.onStatus("");
    props.onMethod("");
    props.onType("");
    props.onServer("");
  };

  const serverOptions = useMemo(
    () => Array.from(new Set([...props.servers, ...(props.filter.server ? [props.filter.server] : [])])),
    [props.servers, props.filter.server],
  );

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput value={searchInput} onChange={setSearchInput} busy={busy} />
        </div>
        <Chips
          options={[
            { value: "", label: t("All sources") },
            { value: "exchange", label: t("Client") },
            { value: "lookup", label: t("Internal") },
            { value: "background", label: t("Background refresh") },
          ]}
          value={props.filter.method ?? ""}
          onChange={props.onMethod}
        />
        <div className={styles.toolbarEnd}>
          <Select
            inline
            value={props.filter.status ?? ""}
            onChange={props.onStatus}
            options={[
              { value: "", label: t("All statuses") },
              ...STATUSES.map((status) => ({ value: status, label: statusLabel(status, t) })),
            ]}
          />
          <Select
            inline
            value={props.filter.queryType ?? ""}
            onChange={props.onType}
            options={[
              { value: "", label: t("All types") },
              ...QUERY_TYPES.map((type) => ({ value: type, label: type })),
            ]}
          />
          {serverOptions.length > 0 && (
            <Select
              inline
              value={props.filter.server ?? ""}
              onChange={props.onServer}
              options={[
                { value: "", label: t("All servers") },
                ...serverOptions.map((server) => ({ value: server, label: server })),
              ]}
            />
          )}
          {hasActiveFilters && (
            <Button size="small" onClick={resetFilters}>
              <Icon name="close" size={12} />
              {t("Reset")}
            </Button>
          )}
          <button
            type="button"
            className={cx("chip", live && "active", styles.liveChip)}
            aria-pressed={live}
            title={live ? t("Pause") : t("Resume")}
            onClick={() => setLive(!live)}
          >
            <Icon name={live ? "pause" : "play_arrow"} size={12} />
            {live ? t("Live") : t("Paused")}
            {log.pendingCount > 0 && <span className="chip-count">+{log.pendingCount}</span>}
          </button>
        </div>
      </div>
      <div
        className={styles.list}
        aria-busy={busy || undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") {
            setHovering(true);
          }
        }}
        onPointerLeave={() => setHovering(false)}
      >
        <LoadingBar active={busy} />
        {busy && log.entries.length === 0 ? (
          <EmptyState>
            <LoadingDots />
          </EmptyState>
        ) : log.entries.length === 0 ? (
          <EmptyState icon="search">{t("No queries match the filters")}</EmptyState>
        ) : (
          <div className={cx(busy && "busy-dim")}>
            <div className={cx(styles.grid, styles.header)} aria-hidden="true">
              <span>{t("Type")}</span>
              <span>{t("Domain")}</span>
              <span>{t("Status")}</span>
              <span>{t("Answer")}</span>
              <span className={styles.num}>{t("Duration")}</span>
            </div>
            {log.entries.map((entry) => (
              <LogRow key={String(entry.id)} entry={entry} onOpen={setSelected} />
            ))}
          </div>
        )}
        {log.hasMore && (
          <div className={styles.more}>
            <Button size="small" disabled={log.loadingMore} onClick={log.loadMore}>
              {log.loadingMore && <Spinner />}
              {t("Load more")}
            </Button>
          </div>
        )}
      </div>
      {selected !== null && (
        <EntryDetail
          entry={selected}
          onClose={() => setSelected(null)}
          onFilterDomain={(domain) => {
            setSelected(null);
            setSearchInput(domain);
            props.onSearch(domain);
          }}
        />
      )}
    </>
  );
}

function entryServer(entry: DNSQueryLogEntry): string {
  const last = entry.upstreams.filter((upstream) => !upstream.rejected).at(-1) ?? entry.upstreams.at(-1);
  return last?.server ?? "";
}

function formatClientSub(entry: DNSQueryLogEntry, t: Translate): string {
  const parts: string[] = [];
  if (entry.process !== "") {
    const tokens = entry.process.split(/[\\/]/);
    parts.push(tokens[tokens.length - 1] || entry.process);
  }
  if (entry.source !== "") {
    parts.push(hostOf(entry.source));
  }
  if (entry.inbound !== "") {
    parts.push(entry.inbound);
  }
  if (parts.length === 0) {
    parts.push(methodLabel(entry.method, t));
    if (entry.outbound !== "") {
      parts.push(entry.outbound);
    }
  } else if (entry.method === "background") {
    parts.push(t("Background refresh"));
  }
  return parts.join(" · ");
}

function formatRouteSub(entry: DNSQueryLogEntry, t: Translate): string {
  const server = entryServer(entry);
  const lastRule = entry.rules.at(-1);
  const parts: string[] = [];
  if (server !== "") {
    parts.push(server);
  }
  if (lastRule) {
    parts.push(`#${lastRule.index} ${lastRule.action}`);
  }
  if (parts.length === 0) {
    parts.push(methodLabel(entry.method, t));
  }
  return parts.join(" · ");
}

function formatAnswerLines(entry: DNSQueryLogEntry): { main: string; sub: string; extraCount: number } {
  if (entry.error !== "") {
    return {
      main: entry.error,
      sub: entry.rcode || "",
      extraCount: 0,
    };
  }
  const metaParts: string[] = [];
  if (entry.rcode !== "" && (entry.answers.length > 0 || entry.ttl > 0)) {
    metaParts.push(entry.rcode);
  }
  if (entry.ttl > 0) {
    metaParts.push(`TTL ${entry.ttl}s`);
  }

  if (entry.answers.length === 0) {
    return {
      main: entry.rcode || "—",
      sub: metaParts.join(" · "),
      extraCount: 0,
    };
  }

  const direct = entry.answers.filter((item) => !item.startsWith("CNAME "));
  const cnames = entry.answers.filter((item) => item.startsWith("CNAME "));

  if (direct.length > 0 && cnames.length > 0) {
    const subParts = [cnames[0], ...metaParts];
    return {
      main: direct.join(", "),
      sub: subParts.join(" · "),
      extraCount: Math.max(0, entry.answers.length - 1),
    };
  }

  return {
    main: entry.answers[0],
    sub: [...entry.answers.slice(1, 2), ...metaParts].join(" · "),
    extraCount: Math.max(0, entry.answers.length - 1),
  };
}

// Rows are memoized: live updates prepend entries every few hundred
// milliseconds, and the rows already shown do not change.
const LogRow = memo(function LogRow(props: {
  entry: DNSQueryLogEntry;
  onOpen: (entry: DNSQueryLogEntry) => void;
}) {
  const { t } = useI18n();
  const entry = props.entry;
  const clientSub = formatClientSub(entry, t);
  const routeSub = formatRouteSub(entry, t);
  const answer = formatAnswerLines(entry);
  const fullAnswer = entry.error !== "" ? entry.error : entry.answers.join(", ") || entry.rcode;
  const open = () => props.onOpen(entry);

  return (
    <div
      role="button"
      tabIndex={0}
      className={cx(styles.grid, styles.row)}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          open();
        }
      }}
    >
      <span className={styles.typeCell}>
        <Badge>{entry.queryType}</Badge>
      </span>
      <span className={styles.cell}>
        <span className={styles.domain} title={entry.domain}>
          {entry.domain}
        </span>
        <span className={styles.sub} title={clientSub}>
          {clientSub}
        </span>
      </span>
      <span className={styles.cell}>
        <span className={styles.statusWrap}>
          <Badge tone={statusTone(entry.status)}>{statusLabel(entry.status, t)}</Badge>
        </span>
        <span className={styles.sub} title={routeSub}>
          {routeSub}
        </span>
      </span>
      <span className={styles.cell} title={fullAnswer}>
        <span className={cx(styles.answerMain, entry.error !== "" && styles.warn)}>
          <span className={styles.answerText}>{answer.main}</span>
          {answer.extraCount > 0 && <span className={styles.answerCount}>+{answer.extraCount}</span>}
        </span>
        {answer.sub !== "" && <span className={styles.sub}>{answer.sub}</span>}
      </span>
      <span className={cx(styles.cell, styles.num)}>
        <span className={cx(styles.duration, durationTone(entry.duration, entry.error !== ""))}>
          {formatMicros(entry.duration)}
        </span>
        <span className={styles.sub}>{formatClockTime(Number(entry.time))}</span>
      </span>
    </div>
  );
});

function EntryDetail(props: {
  entry: DNSQueryLogEntry;
  onClose: () => void;
  onFilterDomain: (domain: string) => void;
}) {
  const { t, language } = useI18n();
  const entry = props.entry;
  return (
    <DetailShell
      backLabel={t("Query log")}
      title={<span className={styles.detailTitle}>{entry.domain}</span>}
      accessory={<Badge tone={statusTone(entry.status)}>{statusLabel(entry.status, t)}</Badge>}
      onClose={props.onClose}
    >
      <div className={styles.detailStats}>
        <div>
          <div className="metric-label">{t("Type")}</div>
          <span className={styles.detailValue}>{entry.queryType}</span>
        </div>
        <div>
          <div className="metric-label">{t("Duration")}</div>
          <span className={cx(styles.detailValue, durationTone(entry.duration, entry.error !== ""))}>
            {formatMicros(entry.duration)}
          </span>
        </div>
        <div>
          <div className="metric-label">{entry.ttl > 0 ? "TTL" : "RCODE"}</div>
          <span className={styles.detailValue}>
            {entry.ttl > 0 ? `${entry.ttl}s` : entry.rcode || "—"}
          </span>
        </div>
      </div>
      <DetailSection
        title={t("Query")}
        accessory={
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => props.onFilterDomain(entry.domain)}
          >
            <Icon name="search" size={13} />
            {t("Domain")}
          </button>
        }
      >
        <DataLine label={t("Domain")} value={<CopyValue value={entry.domain} />} mono />
        <DataLine label={t("Time")} value={formatDateTime(Number(entry.time), language)} />
        <DataLine label={t("Method")} value={methodLabel(entry.method, t)} />
        {entry.rcode !== "" && <DataLine label="RCODE" value={entry.rcode} mono />}
        {entry.ttl > 0 && <DataLine label="TTL" value={`${entry.ttl}s`} mono />}
      </DetailSection>
      {(entry.inbound !== "" || entry.source !== "" || entry.process !== "" || entry.user !== "") && (
        <DetailSection title={t("Client")}>
          {entry.inbound !== "" && (
            <DataLine label={t("Inbound")} value={`${entry.inboundType}/${entry.inbound}`} mono />
          )}
          {entry.source !== "" && (
            <DataLine label={t("Source")} value={<CopyValue value={entry.source} />} mono />
          )}
          {entry.process !== "" && <DataLine label={t("Process")} value={entry.process} mono />}
          {entry.user !== "" && <DataLine label={t("User")} value={entry.user} mono />}
          {entry.outbound !== "" && <DataLine label={t("Outbound")} value={entry.outbound} mono />}
          {entry.destination !== "" && <DataLine label={t("Destination")} value={entry.destination} mono />}
        </DetailSection>
      )}
      {(entry.answers.length > 0 || entry.error !== "") && (
        <DetailSection title={t("Answer")}>
          {entry.error !== "" && <DataLine label={t("Error")} value={entry.error} mono />}
          {entry.answers.map((answer, index) => (
            <DataLine
              key={index}
              label={index === 0 ? t("Records") : ""}
              value={<CopyValue value={answer} />}
              mono
            />
          ))}
        </DetailSection>
      )}
      {entry.rules.length > 0 && (
        <DetailSection title={t("Matched rules")}>
          {entry.rules.map((rule, index) => (
            <div key={index} className={styles.ruleLine}>
              <span className={styles.ruleIndex}>#{rule.index}</span>
              <span className={styles.ruleText}>
                <span className="mono">{rule.rule}</span>
                <span className="faint"> → {rule.action}</span>
              </span>
            </div>
          ))}
        </DetailSection>
      )}
      {entry.upstreams.length > 0 && (
        <DetailSection title={t("Upstream exchanges")}>
          {entry.upstreams.map((upstream, index) => (
            <div key={index} className={styles.exchange}>
              <div className={styles.exchangeHead}>
                <span className={styles.serverName}>{upstream.server}</span>
                <span className="faint">{upstream.type}</span>
                <span className="mono faint">{upstream.queryType}</span>
                <span className={cx("mono", styles.exchangeTime)}>{formatMicros(upstream.duration)}</span>
              </div>
              {upstream.address !== "" && (
                <div className="mono faint">
                  {upstream.address}
                  {upstream.detour !== "" && ` → ${upstream.detour}`}
                </div>
              )}
              {upstream.error !== "" ? (
                <div className={cx("mono", styles.warn)}>{upstream.error}</div>
              ) : (
                <div className="mono secondary">{upstream.answers.join(", ") || upstream.rcode}</div>
              )}
              {upstream.rejected && <Badge tone="bad">{t("Rejected by a later rule")}</Badge>}
            </div>
          ))}
        </DetailSection>
      )}
    </DetailShell>
  );
}
