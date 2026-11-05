import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { DNSQueryFilter } from "../api/extended";
import { formatBytes, formatClockTime, formatDateTime } from "../api/format";
import { useExtension } from "../app/capabilities";
import { useApi } from "../app/context";
import { showError } from "../app/errorStore";
import { useUnaryOnce } from "../app/hooks";
import { useI18n, type Translate } from "../app/i18n";
import { Board, Chips, Metric, Panel, PanelHead, SectionHead } from "../components/Board";
import { BarTooltip, useElementWidth } from "../components/charts";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import {
  Badge,
  Button,
  DataLine,
  DetailSection,
  DetailShell,
  Dialog,
  EmptyState,
  MenuItem,
  OthersMenu,
  SearchInput,
  LoadingBar,
  Select,
  Spinner,
  type BadgeTone,
} from "../components/ui";
import type {
  DNSQueryLogEntry,
  DNSQueryLogStats,
  DNSQueryLogStatsCount,
  DNSQueryLogStatsRule,
} from "../gen/daemon/extended_service_pb";
import { cx } from "../lib/cx";
import styles from "./DnsView.module.css";

const PAGE_SIZE = 100;
const LIVE_MAX_ENTRIES = 1000;

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

const METHODS = ["exchange", "lookup", "background"] as const;

const QUERY_TYPES = ["A", "AAAA", "HTTPS", "CNAME", "MX", "TXT", "SRV", "PTR", "NS", "SOA"];

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

  return (
    <div className="page">
      <PageHeader
        title="DNS"
        actions={
          <>
            {cacheSupported && (
              <Button disabled={flushing} onClick={flush}>
                {flushing ? <Spinner /> : <Icon name={flushed ? "check" : "eraser"} />}
                {flushed ? t("Cache flushed") : t("Flush DNS cache")}
              </Button>
            )}
            {logSupported && status?.enabled && (
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
          <Spinner />
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

function DnsContent(props: { storage: string }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>("24h");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [serverFilter, setServerFilter] = useState("");
  const [methodFilter, setMethodFilter] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const { stats, loading: statsLoading } = useStats(range);
  // Cores that count entries by method also rank the domains of clients and
  // of the core apart, rank block rules and filter by method.
  const split = stats !== null && Object.keys(stats.methods).length > 0;

  const focusSearch = (value: string, status = "") => {
    setSearch(value);
    setStatusFilter(status);
    setMethodFilter("");
    logRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const servers = useMemo(
    () => (stats?.upstreams ?? []).map((upstream) => upstream.server).filter((value, index, list) => list.indexOf(value) === index),
    [stats],
  );

  return (
    <>
      <div className={styles.rangeBar}>
        <Chips
          options={[
            { value: "1h", label: t("1 hour") },
            { value: "24h", label: t("24 hours") },
            { value: "7d", label: t("7 days") },
          ]}
          value={range}
          onChange={setRange}
        />
        <span className={styles.rangeMeta}>
          {statsLoading && <Spinner />}
          <span className="faint mono">{props.storage}</span>
        </span>
      </div>
      <Board className={cx(statsLoading && stats !== null && "busy-dim")}>
        <SummaryPanel stats={stats} split={split} />
        <DomainsPanel stats={stats} split={split} onPick={(key) => focusSearch(key)} />
        <BlockedPanel
          stats={stats}
          split={split}
          onPickDomain={(key) => focusSearch(key)}
          onPickRule={(status) => focusSearch("", status)}
        />
        <TopPanel
          icon="computer"
          title={t("Top clients")}
          items={countItems(stats?.topClients ?? [], (key) => focusSearch(key))}
        />
        <UpstreamsPanel stats={stats} onPick={(server) => setServerFilter(server)} />
      </Board>
      <div ref={logRef} className={styles.logAnchor}>
        <SectionHead title={t("Query log")} />
      </div>
      <QueryLog
        filter={{ search, status: statusFilter, method: methodFilter, queryType: typeFilter, server: serverFilter }}
        servers={servers}
        methods={split}
        onSearch={setSearch}
        onStatus={setStatusFilter}
        onMethod={setMethodFilter}
        onType={setTypeFilter}
        onServer={setServerFilter}
      />
    </>
  );
}

// `loading` covers the first answer for a range, not the quiet refreshes
// that follow it, so switching ranges is visibly in progress.
function useStats(range: Range): { stats: DNSQueryLogStats | null; loading: boolean } {
  const api = useApi();
  const [stats, setStats] = useState<DNSQueryLogStats | null>(null);
  const [loadedRange, setLoadedRange] = useState<Range | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      const { span, bucket } = RANGES[range];
      api.extended
        .dnsLogStats({ since: Date.now() - span }, bucket, 8, controller.signal)
        .then(
          (result) => {
            setStats(result);
            setLoadedRange(range);
          },
          (error: unknown) => {
            if (!controller.signal.aborted) {
              setLoadedRange(range);
              showError(error);
            }
          },
        );
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, range]);
  return { stats, loading: loadedRange !== range };
}

function sumStatuses(statuses: Record<string, bigint> | undefined, keys: string[]): number {
  if (!statuses) {
    return 0;
  }
  return keys.reduce((sum, key) => sum + Number(statuses[key] ?? 0n), 0);
}

const BLOCKED = ["rejected", "predefined"];
const CACHED = ["cached", "optimistic"];

function SummaryPanel(props: { stats: DNSQueryLogStats | null; split: boolean }) {
  const { t } = useI18n();
  const stats = props.stats;
  const total = Number(stats?.total ?? 0);
  const blocked = sumStatuses(stats?.statuses, BLOCKED);
  const cached = sumStatuses(stats?.statuses, CACHED);
  const failed = sumStatuses(stats?.statuses, ["error"]);
  const buckets = stats?.buckets ?? [];
  const max = Math.max(...buckets.map((bucket) => Number(bucket.total)), 1);
  const percent = (value: number) => (total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "—");
  const [chartRef, chartWidth] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover !== null ? buckets[hover] : undefined;

  return (
    <Panel>
      <div className={styles.summary}>
        <div className={styles.summaryMetric}>
          <div className="metric-label">{t("Queries")}</div>
          <Metric value={stats ? total.toLocaleString() : "—"} size="large" />
          {props.split && stats && (
            <div className="metric-foot">
              {t("Clients {client} · internal {internal}", {
                client: Number(stats.methods.exchange ?? 0n).toLocaleString(),
                internal: (total - Number(stats.methods.exchange ?? 0n)).toLocaleString(),
              })}
            </div>
          )}
        </div>
        <div className={styles.summaryMetric}>
          <div className="metric-label">
            <span className={cx(styles.key, styles.keyBlocked)} />
            {t("Blocked")}
          </div>
          <Metric value={stats ? blocked.toLocaleString() : "—"} unit={percent(blocked)} size="medium" />
        </div>
        <div className={styles.summaryMetric}>
          <div className="metric-label">
            <span className={cx(styles.key, styles.keyCached)} />
            {t("From cache")}
          </div>
          <Metric value={stats ? cached.toLocaleString() : "—"} unit={percent(cached)} size="medium" />
        </div>
        <div className={styles.summaryMetric}>
          <div className="metric-label">
            <span className={cx(styles.key, styles.keyError)} />
            {t("Failed")}
          </div>
          <Metric value={stats ? failed.toLocaleString() : "—"} unit={percent(failed)} size="medium" />
        </div>
        <div className={styles.summaryMetric}>
          <div className="metric-label">{t("Upstream latency")}</div>
          <Metric
            value={stats?.upstreamDuration ? formatMicros(stats.upstreamDuration.average).split(" ")[0] : "—"}
            unit={stats?.upstreamDuration ? formatMicros(stats.upstreamDuration.average).split(" ")[1] : undefined}
            size="medium"
          />
          <div className="metric-foot">
            P95 <strong>{stats?.upstreamDuration ? formatMicros(stats.upstreamDuration.p95) : "—"}</strong>
          </div>
        </div>
      </div>
      <div
        ref={chartRef}
        className={styles.histogram}
        role="img"
        aria-label={`${t("Queries")}: ${total.toLocaleString()}`}
        onPointerLeave={() => setHover(null)}
      >
        {buckets.map((bucket, index) => {
          const value = Number(bucket.total);
          const parts = [
            { className: styles.barBlocked, value: sumStatuses(bucket.statuses, BLOCKED) },
            { className: styles.barError, value: sumStatuses(bucket.statuses, ["error"]) },
            { className: styles.barCached, value: sumStatuses(bucket.statuses, CACHED) },
          ];
          const rest = value - parts.reduce((sum, part) => sum + part.value, 0);
          return (
            <div
              key={String(bucket.time)}
              className={cx(styles.bar, hover !== null && hover !== index && styles.barDimmed)}
              onPointerEnter={() => setHover(index)}
            >
              <div className={styles.barStack} style={{ height: `${(value / max) * 100}%` }}>
                {parts.map(
                  (part, index) =>
                    part.value > 0 && (
                      <span key={index} className={part.className} style={{ flexGrow: part.value }} />
                    ),
                )}
                {rest > 0 && <span className={styles.barRest} style={{ flexGrow: rest }} />}
              </div>
            </div>
          );
        })}
        {hovered && hover !== null && chartWidth > 0 && (
          <BarTooltip index={hover} count={buckets.length} width={chartWidth}>
            <div className="tooltip-value">{Number(hovered.total).toLocaleString()}</div>
            <div className="tooltip-rows">
              <span>{t("From cache")}</span>
              <span>{sumStatuses(hovered.statuses, CACHED).toLocaleString()}</span>
              <span>{t("Blocked")}</span>
              <span>{sumStatuses(hovered.statuses, BLOCKED).toLocaleString()}</span>
              <span>{t("Failed")}</span>
              <span>{sumStatuses(hovered.statuses, ["error"]).toLocaleString()}</span>
            </div>
            <div className="tooltip-meta">{formatDateTime(Number(hovered.time))}</div>
          </BarTooltip>
        )}
      </div>
      <div className={cx("metric-foot", styles.histogramFoot)}>
        <span>{buckets.length > 0 ? formatDateTime(Number(buckets[0].time)) : ""}</span>
        <span className="legend">
          <span className="legend-item">
            <span className={cx(styles.key, styles.keyRest)} />
            {t("Upstream")}
          </span>
          <span className="legend-item">
            <span className={cx(styles.key, styles.keyCached)} />
            {t("From cache")}
          </span>
          <span className="legend-item">
            <span className={cx(styles.key, styles.keyBlocked)} />
            {t("Blocked")}
          </span>
          <span className="legend-item">
            <span className={cx(styles.key, styles.keyError)} />
            {t("Failed")}
          </span>
        </span>
        <span>{t("now")}</span>
      </div>
    </Panel>
  );
}

interface TopItem {
  key: string;
  // Replaces the position in the ranking, such as with the index of a rule.
  rank?: string;
  label: ReactNode;
  title: string;
  count: number;
  tag?: ReactNode;
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

function TopList(props: { items: TopItem[]; tone?: "accent"; empty?: string }) {
  const { t } = useI18n();
  const max = Math.max(...props.items.map((item) => item.count), 1);
  if (props.items.length === 0) {
    return <div className={styles.topEmpty}>{props.empty ?? t("No data yet")}</div>;
  }
  return (
    <ol className={styles.top}>
      {props.items.map((item, index) => (
        <li key={item.key}>
          <button type="button" className={styles.topRow} onClick={item.onPick} title={item.title}>
            <span className={styles.topRank}>{item.rank ?? String(index + 1).padStart(2, "0")}</span>
            <span className={styles.topBody}>
              <span className={styles.topKey}>
                {item.tag}
                {item.label}
              </span>
              <span className={styles.topTrack}>
                <span
                  className={cx(styles.topFill, props.tone === "accent" && styles.topFillAccent)}
                  style={{ width: `${(item.count / max) * 100}%` }}
                />
              </span>
            </span>
            <span className={styles.topCount}>{item.count.toLocaleString()}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function TopPanel(props: {
  icon: "dns" | "direct_off" | "computer";
  title: string;
  items: TopItem[];
  tone?: "accent";
  empty?: string;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Panel span={4}>
      <PanelHead icon={props.icon} title={props.title} actions={props.actions} />
      <TopList items={props.items} tone={props.tone} empty={props.empty} />
      {props.footer}
    </Panel>
  );
}

type DomainSource = "client" | "internal";

// Clients' queries rank apart from the lookups and refreshes the core makes
// itself, which would otherwise crowd them out.
function DomainsPanel(props: {
  stats: DNSQueryLogStats | null;
  split: boolean;
  onPick: (key: string) => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<DomainSource>("client");
  const internal = props.split && source === "internal";
  const counts = (internal ? props.stats?.topInternalDomains : props.stats?.topDomains) ?? [];
  return (
    <TopPanel
      icon="dns"
      title={t("Top domains")}
      items={countItems(counts, props.onPick)}
      actions={
        props.split && (
          <Chips
            className={styles.panelSwitch}
            options={[
              { value: "client", label: t("Client") },
              { value: "internal", label: t("Internal") },
            ]}
            value={source}
            onChange={setSource}
          />
        )
      }
    />
  );
}

type BlockedView = "domains" | "rules";

function ruleStatus(rule: DNSQueryLogStatsRule): string {
  return rule.actionType === "reject" ? "rejected" : "predefined";
}

// Domains blocked by rules that name them, and the block rules themselves:
// a policy rule, such as one answering every AAAA query, is one row there
// rather than every domain in the domain ranking.
function BlockedPanel(props: {
  stats: DNSQueryLogStats | null;
  split: boolean;
  onPickDomain: (key: string) => void;
  onPickRule: (status: string) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<BlockedView>("domains");
  const rules = props.stats?.topBlockRules ?? [];
  const policyCount = rules.reduce((sum, rule) => sum + (rule.policy ? Number(rule.count) : 0), 0);
  const byRule = props.split && view === "rules";
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
        tag: rule.policy ? <span className={styles.ruleTag}>{t("policy")}</span> : undefined,
        onPick: () => props.onPickRule(ruleStatus(rule)),
      }))
    : countItems(props.stats?.topBlockedDomains ?? [], props.onPickDomain);
  return (
    <TopPanel
      icon="direct_off"
      title={t("Top blocked")}
      items={items}
      tone="accent"
      empty={t("Nothing blocked")}
      actions={
        props.split && (
          <Chips
            className={styles.panelSwitch}
            options={[
              { value: "domains", label: t("Domain") },
              { value: "rules", label: t("Rule") },
            ]}
            value={view}
            onChange={setView}
          />
        )
      }
      footer={
        props.split &&
        !byRule &&
        policyCount > 0 && (
          <button type="button" className={styles.topFoot} onClick={() => setView("rules")}>
            {t("{count} more answered by policy rules", { count: policyCount.toLocaleString() })}
          </button>
        )
      }
    />
  );
}

function UpstreamsPanel(props: { stats: DNSQueryLogStats | null; onPick: (server: string) => void }) {
  const { t } = useI18n();
  const upstreams = props.stats?.upstreams ?? [];
  return (
    <Panel>
      <PanelHead icon="waypoints" title={t("Upstream servers")} />
      {upstreams.length === 0 ? (
        <div className={styles.topEmpty}>{t("No data yet")}</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("Server")}</th>
                <th>{t("Address")}</th>
                <th className={styles.num}>{t("Exchanges")}</th>
                <th className={styles.num}>{t("Failed")}</th>
                <th className={styles.num}>{t("Rejected")}</th>
                <th className={styles.num}>{t("Average")}</th>
                <th className={styles.num}>P95</th>
              </tr>
            </thead>
            <tbody>
              {upstreams.map((upstream) => {
                const exchanges = Number(upstream.exchanges);
                const failed = Number(upstream.failed);
                return (
                  <tr key={`${upstream.server}/${upstream.address}`} onClick={() => props.onPick(upstream.server)}>
                    <td>
                      <span className={styles.serverName}>{upstream.server}</span>
                      <span className="faint"> {upstream.type}</span>
                    </td>
                    <td className="mono secondary">
                      {upstream.address || "—"}
                      {upstream.detour !== "" && <span className="faint"> → {upstream.detour}</span>}
                    </td>
                    <td className={styles.num}>{exchanges.toLocaleString()}</td>
                    <td className={cx(styles.num, failed > 0 && styles.warn)}>
                      {failed.toLocaleString()}
                      {exchanges > 0 && failed > 0 && (
                        <span className="faint"> {((failed / exchanges) * 100).toFixed(0)}%</span>
                      )}
                    </td>
                    <td className={styles.num}>{Number(upstream.rejected).toLocaleString()}</td>
                    <td className={styles.num}>{upstream.duration ? formatMicros(upstream.duration.average) : "—"}</td>
                    <td className={styles.num}>{upstream.duration ? formatMicros(upstream.duration.p95) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------ query log */

function useQueryLog(filter: DNSQueryFilter, live: boolean) {
  const api = useApi();
  const [entries, setEntries] = useState<DNSQueryLogEntry[]>([]);
  const [next, setNext] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = JSON.stringify(filter);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.extended
      .queryDnsLog(filter, 0n, PAGE_SIZE, controller.signal)
      .then(
        (page) => {
          setEntries(page.entries);
          setNext(page.next);
        },
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
            setEntries((current) => {
              const seen = new Set(current.map((item) => item.id));
              const merged = fresh.filter((item) => !seen.has(item.id)).concat(current);
              return merged.length > LIVE_MAX_ENTRIES ? merged.slice(0, LIVE_MAX_ENTRIES) : merged;
            });
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
    if (next === 0n || loadingMore) {
      return;
    }
    setLoadingMore(true);
    api.extended
      .queryDnsLog(filter, next, PAGE_SIZE)
      .then((page) => {
        setEntries((current) => {
          const seen = new Set(current.map((item) => item.id));
          return current.concat(page.entries.filter((item) => !seen.has(item.id)));
        });
        setNext(page.next);
      }, showError)
      .finally(() => setLoadingMore(false));
  };

  return { entries, loading, hasMore: next !== 0n, loadingMore, loadMore };
}

function QueryLog(props: {
  filter: DNSQueryFilter;
  servers: string[];
  methods: boolean;
  onSearch: (value: string) => void;
  onStatus: (value: string) => void;
  onMethod: (value: string) => void;
  onType: (value: string) => void;
  onServer: (value: string) => void;
}) {
  const { t } = useI18n();
  const [live, setLive] = useState(true);
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

  const log = useQueryLog(props.filter, live);
  // Busy from the first keystroke: the debounce and the query both count.
  const typing = searchInput.trim() !== (props.filter.search ?? "").trim();
  const busy = log.loading || typing;

  return (
    <>
      <div className={styles.filters}>
        <div className={styles.filterSearch}>
          <SearchInput value={searchInput} onChange={setSearchInput} busy={busy} />
        </div>
        <Select
          inline
          value={props.filter.status ?? ""}
          onChange={props.onStatus}
          options={[
            { value: "", label: t("All statuses") },
            ...STATUSES.map((status) => ({ value: status, label: statusLabel(status, t) })),
          ]}
        />
        {props.methods && (
          <Select
            inline
            value={props.filter.method ?? ""}
            onChange={props.onMethod}
            options={[
              { value: "", label: t("All sources") },
              ...METHODS.map((method) => ({
                value: method,
                label: method === "exchange" ? t("Client queries") : methodLabel(method, t),
              })),
            ]}
          />
        )}
        <Select
          inline
          value={props.filter.queryType ?? ""}
          onChange={props.onType}
          options={[{ value: "", label: t("All types") }, ...QUERY_TYPES.map((type) => ({ value: type, label: type }))]}
        />
        <Select
          inline
          value={props.filter.server ?? ""}
          onChange={props.onServer}
          options={[
            { value: "", label: t("All servers") },
            ...Array.from(new Set([...props.servers, ...(props.filter.server ? [props.filter.server] : [])])).map(
              (server) => ({ value: server, label: server }),
            ),
          ]}
        />
        <button
          type="button"
          className={cx("chip", live && "active", styles.liveChip)}
          aria-pressed={live}
          onClick={() => setLive(!live)}
        >
          <Icon name={live ? "pause" : "play_arrow"} size={12} />
          {live ? t("Live") : t("Paused")}
        </button>
      </div>
      <div className={styles.logPanel} aria-busy={busy || undefined}>
        <LoadingBar active={busy} />
        {busy && log.entries.length === 0 ? (
          <EmptyState>
            <Spinner />
          </EmptyState>
        ) : log.entries.length === 0 ? (
          <EmptyState icon="search">{t("No queries match the filters")}</EmptyState>
        ) : (
          <div className={cx(styles.tableWrap, busy && "busy-dim")}>
            <table className={cx(styles.table, styles.logTable)}>
              <thead>
                <tr>
                  <th>{t("Time")}</th>
                  <th>{t("Domain")}</th>
                  <th>{t("Type")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Client")}</th>
                  <th>{t("Server")}</th>
                  <th>{t("Answer")}</th>
                  <th className={styles.num}>{t("Duration")}</th>
                </tr>
              </thead>
              <tbody>
                {log.entries.map((entry) => (
                  <LogRow key={String(entry.id)} entry={entry} onOpen={() => setSelected(entry)} />
                ))}
              </tbody>
            </table>
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
      {selected !== null && <EntryDetail entry={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function entryServer(entry: DNSQueryLogEntry): string {
  const last = entry.upstreams.filter((upstream) => !upstream.rejected).at(-1) ?? entry.upstreams.at(-1);
  return last?.server ?? "";
}

function LogRow(props: { entry: DNSQueryLogEntry; onOpen: () => void }) {
  const { t } = useI18n();
  const entry = props.entry;
  const answer = entry.error !== "" ? entry.error : entry.answers.join(", ") || entry.rcode;
  return (
    <tr className={styles.logRow} onClick={props.onOpen}>
      <td className="mono faint">{formatClockTime(Number(entry.time))}</td>
      <td className={styles.domain}>
        <span title={entry.domain}>{entry.domain}</span>
        {entry.method === "background" && <span className={styles.method}>{t("refresh")}</span>}
      </td>
      <td className="mono secondary">{entry.queryType}</td>
      <td>
        <Badge tone={statusTone(entry.status)}>{statusLabel(entry.status, t)}</Badge>
      </td>
      <td className={cx("mono secondary", styles.clip)}>
        {entry.process !== "" ? entry.process : entry.source !== "" ? entry.source : entry.inbound || "—"}
      </td>
      <td className={cx("secondary", styles.clip)}>{entryServer(entry) || "—"}</td>
      <td className={cx("mono", styles.answer, entry.error !== "" && styles.warn)} title={answer}>
        {answer || "—"}
      </td>
      <td className={cx(styles.num, "mono")}>{formatMicros(entry.duration)}</td>
    </tr>
  );
}

function EntryDetail(props: { entry: DNSQueryLogEntry; onClose: () => void }) {
  const { t, language } = useI18n();
  const entry = props.entry;
  return (
    <DetailShell
      backLabel={t("Query log")}
      title={<span className={styles.detailTitle}>{entry.domain}</span>}
      accessory={<Badge tone={statusTone(entry.status)}>{statusLabel(entry.status, t)}</Badge>}
      onClose={props.onClose}
    >
      <DetailSection title={t("Query")}>
        <DataLine label={t("Time")} value={formatDateTime(Number(entry.time), language)} />
        <DataLine label={t("Type")} value={entry.queryType} mono />
        <DataLine label={t("Method")} value={methodLabel(entry.method, t)} />
        <DataLine label={t("Duration")} value={formatMicros(entry.duration)} mono />
        {entry.rcode !== "" && <DataLine label="RCODE" value={entry.rcode} mono />}
        {entry.ttl > 0 && <DataLine label="TTL" value={`${entry.ttl}s`} mono />}
      </DetailSection>
      {(entry.inbound !== "" || entry.source !== "" || entry.process !== "" || entry.user !== "") && (
        <DetailSection title={t("Client")}>
          {entry.inbound !== "" && (
            <DataLine label={t("Inbound")} value={`${entry.inboundType}/${entry.inbound}`} mono />
          )}
          {entry.source !== "" && <DataLine label={t("Source")} value={entry.source} mono />}
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
            <DataLine key={index} label={index === 0 ? t("Records") : ""} value={answer} mono />
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
                {rule.policy && <span className={styles.method}>{t("policy")}</span>}
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
