import { Code } from "@connectrpc/connect";
import { memo, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ConnectionRow } from "../api/daemon";
import { formatBytes, formatClockTime, formatDateTime, formatDurationMs } from "../api/format";
import { cx } from "../lib/cx";
import { useStream } from "../api/stream";
import {
  loadConnectionSortMode,
  loadConnectionStateFilter,
  saveConnectionSortMode,
  saveConnectionStateFilter,
  type ConnectionSortMode,
  type ConnectionStateFilter,
} from "../app/connectionPreferences";
import { useApi, useIsMobile, useNow } from "../app/context";
import { showError } from "../app/errorStore";
import { useI18n, type MessageKey } from "../app/i18n";
import { Chips } from "../components/Board";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamStates } from "../components/StreamBanner";
import { Badge, Button, DataLine, DetailSection, DetailShell, Dialog, IconButton, SearchInput, Select } from "../components/ui";
import styles from "./ConnectionsView.module.css";

const STATE_OPTIONS: { value: ConnectionStateFilter; label: MessageKey }[] = [
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const EMPTY_MESSAGES: Record<ConnectionStateFilter, MessageKey> = {
  active: "No active connections",
  closed: "No closed connections",
  all: "No connections",
};

const SORT_OPTIONS: { value: ConnectionSortMode; label: MessageKey }[] = [
  { value: "date", label: "By date" },
  { value: "traffic", label: "By traffic" },
  { value: "trafficTotal", label: "By traffic total" },
];

export function ConnectionsView(props: { initialSearch?: string }) {
  const api = useApi();
  const { t } = useI18n();
  const connections = useStream(api.connections);
  const isMobile = useIsMobile();
  const now = useNow(1000);
  const [stateFilter, setStateFilter] = useState<ConnectionStateFilter>(loadConnectionStateFilter);
  const [sortMode, setSortMode] = useState<ConnectionSortMode>(loadConnectionSortMode);
  const [search, setSearch] = useState(props.initialSearch ?? "");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // While paused, or while the pointer is over the list, the order is held
  // so a row does not move out from under the cursor. Values keep updating.
  const frozenRef = useRef<string[] | null>(null);

  const counts = useMemo(() => {
    let active = 0;
    let closed = 0;
    for (const row of connections.data.rows.values()) {
      if (row.closedAt === null) {
        active += 1;
      } else {
        closed += 1;
      }
    }
    return { active, closed, all: active + closed };
  }, [connections.data.rows]);

  const rows = useMemo(() => {
    const result: ConnectionRow[] = [];
    for (const row of connections.data.rows.values()) {
      if (stateFilter === "active" && row.closedAt !== null) {
        continue;
      }
      if (stateFilter === "closed" && row.closedAt === null) {
        continue;
      }
      if (!matchesSearch(row, search)) {
        continue;
      }
      result.push(row);
    }
    result.sort((left, right) => {
      switch (sortMode) {
        case "traffic": {
          const leftRate = left.uplinkRate + left.downlinkRate;
          const rightRate = right.uplinkRate + right.downlinkRate;
          if (rightRate !== leftRate) {
            return rightRate - leftRate;
          }
          break;
        }
        case "trafficTotal": {
          const leftTotal = left.uplinkTotal + left.downlinkTotal;
          const rightTotal = right.uplinkTotal + right.downlinkTotal;
          if (rightTotal !== leftTotal) {
            return rightTotal > leftTotal ? 1 : -1;
          }
          break;
        }
        default:
          break;
      }
      const leftCreated = Number(left.connection.createdAt);
      const rightCreated = Number(right.connection.createdAt);
      return rightCreated - leftCreated;
    });
    return result;
  }, [connections.data.rows, stateFilter, sortMode, search]);

  const frozen = paused || hovering;
  if (!frozen) {
    frozenRef.current = null;
  } else if (frozenRef.current === null) {
    frozenRef.current = rows.map((row) => row.connection.id);
  }
  const order = frozenRef.current;
  const shownRows = useMemo(() => {
    if (order === null) {
      return rows;
    }
    const result: ConnectionRow[] = [];
    for (const id of order) {
      const row = connections.data.rows.get(id);
      if (row) {
        result.push(row);
      }
    }
    return result;
  }, [order, rows, connections.data.rows]);
  const pending = order === null ? 0 : rows.filter((row) => !order.includes(row.connection.id)).length;

  const filtering = search.trim() !== "";
  const closable = rows.filter((row) => row.closedAt === null);
  const closeMatching = () => {
    setConfirming(false);
    if (!filtering) {
      api.closeAllConnections().catch(showError);
      return;
    }
    Promise.all(closable.map((row) => api.closeConnection(row.connection.id))).catch(showError);
  };

  const detailRow = detailId !== null ? (connections.data.rows.get(detailId) ?? null) : null;
  const detailActive = detailRow?.closedAt === null;
  const detail = detailRow && (
    <DetailShell
      backLabel={t("Connections")}
      title={t("Connection")}
      accessory={
        <Badge tone={detailActive ? "good" : undefined}>
          {detailActive ? t("Active") : t("Closed")}
        </Badge>
      }
      onClose={() => setDetailId(null)}
    >
      <ConnectionDetailBody row={detailRow} onClose={() => setDetailId(null)} />
    </DetailShell>
  );

  if (isMobile && detail) {
    return detail;
  }

  return (
    <div className="page">
      <PageHeader
        title={t("Connections")}
        actions={
          <Button variant="danger" disabled={closable.length === 0} onClick={() => setConfirming(true)}>
            <Icon name="close" size={13} />
            {filtering ? t("Close {count} matching", { count: closable.length }) : t("Close all")}
          </Button>
        }
      />
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput value={search} onChange={setSearch} />
        </div>
        <Chips
          options={STATE_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
            count: counts[option.value],
          }))}
          value={stateFilter}
          onChange={(value) => {
            setStateFilter(value);
            saveConnectionStateFilter(value);
          }}
        />
        <div className={styles.toolbarEnd}>
          <Select
            options={SORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
            value={sortMode}
            onChange={(value) => {
              setSortMode(value);
              saveConnectionSortMode(value);
            }}
          />
          <button
            type="button"
            className={cx("chip", !paused && "active", styles.liveChip)}
            aria-pressed={!paused}
            title={paused ? t("Resume") : t("Pause")}
            onClick={() => setPaused(!paused)}
          >
            <Icon name={paused ? "play_arrow" : "pause"} size={12} />
            {paused ? t("Paused") : t("Live")}
            {pending > 0 && <span className="chip-count">+{pending}</span>}
          </button>
        </div>
      </div>
      <StreamStates
        snapshot={connections}
        loaded={connections.data.loaded}
        empty={shownRows.length === 0}
        emptyIcon="swap_vert"
        emptyMessage={t(search.trim() !== "" ? "No matching connections" : EMPTY_MESSAGES[stateFilter])}
      />
      {connections.errorCode === Code.Unimplemented && connections.phase === "error" && (
        <div className="hint" style={{ marginBottom: 12 }}>
          {t("Connection tracking requires the Clash API to be configured in the running instance.")}
        </div>
      )}
      {shownRows.length > 0 && (
        <div
          className={styles.list}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") {
              setHovering(true);
            }
          }}
          onPointerLeave={() => setHovering(false)}
        >
          <div className={cx(styles.grid, styles.header)} aria-hidden="true">
            <span />
            <span>{t("Destination")}</span>
            <span>{t("Outbound")}</span>
            <span className={styles.num}>{t("Rate")}</span>
            <span className={styles.num}>{t("Total")}</span>
            <span className={styles.num}>{t("Duration")}</span>
            <span />
          </div>
          {shownRows.slice(0, 500).map((row) => (
            <ConnectionRowView
              key={row.connection.id}
              row={row}
              now={now}
              onOpen={setDetailId}
              onCloseConnection={(id) => {
                api.closeConnection(id).catch(showError);
              }}
            />
          ))}
        </div>
      )}
      {shownRows.length > 500 && (
        <div className="hint" style={{ textAlign: "center", padding: 8 }}>
          {t("Showing first {limit} of {count} connections", { limit: 500, count: shownRows.length })}
        </div>
      )}
      {confirming && (
        <Dialog onClose={() => setConfirming(false)}>
          <h3>{filtering ? t("Close {count} matching connections?", { count: closable.length }) : t("Close all connections?")}</h3>
          <p className="dialog-message">
            {filtering
              ? t("Only the connections that match the search are closed.")
              : t("Every active connection will be closed. Applications reconnect on their own.")}
          </p>
          <div className="row-actions dialog-actions">
            <Button onClick={() => setConfirming(false)}>{t("Cancel")}</Button>
            <Button variant="danger" onClick={closeMatching}>
              {t("Close")}
            </Button>
          </div>
        </Dialog>
      )}
      {detail}
    </div>
  );
}

function matchesSearch(row: ConnectionRow, search: string): boolean {
  const query = search.trim();
  if (query === "") {
    return true;
  }
  const connection = row.connection;
  // Values with spaces are quoted: outbound:"🇯🇵 TYO 01".
  for (const raw of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const token = raw.replaceAll('"', "");
    const separator = token.indexOf(":");
    let matched: boolean;
    if (separator > 0) {
      const key = token.slice(0, separator).toLowerCase();
      const value = token.slice(separator + 1).toLowerCase();
      switch (key) {
        case "network":
          matched = connection.network.toLowerCase() === value;
          break;
        case "inbound":
          matched = connection.inbound.toLowerCase().includes(value);
          break;
        case "inbound.type":
          matched = connection.inboundType.toLowerCase().includes(value);
          break;
        case "source":
          matched = connection.source.toLowerCase().includes(value);
          break;
        case "destination":
          matched = connection.destination.toLowerCase().includes(value);
          break;
        case "outbound":
          matched = connection.outbound.toLowerCase().includes(value);
          break;
        case "chain":
          matched = connection.chainList.some((tag) => tag.toLowerCase() === value);
          break;
        case "process": {
          const info = connection.processInfo;
          matched =
            info !== undefined &&
            (info.processPath.toLowerCase().includes(value) ||
              info.packageNames.some((name) => name.toLowerCase().includes(value)));
          break;
        }
        default:
          matched = plainMatch(row, token.toLowerCase());
          break;
      }
    } else {
      matched = plainMatch(row, token.toLowerCase());
    }
    if (!matched) {
      return false;
    }
  }
  return true;
}

function plainMatch(row: ConnectionRow, query: string): boolean {
  const connection = row.connection;
  return (
    connection.destination.toLowerCase().includes(query) ||
    connection.domain.toLowerCase().includes(query) ||
    connection.source.toLowerCase().includes(query) ||
    connection.outbound.toLowerCase().includes(query)
  );
}

const ConnectionRowView = memo(function ConnectionRowView(props: {
  row: ConnectionRow;
  now: number;
  onOpen: (id: string) => void;
  onCloseConnection: (id: string) => void;
}) {
  const { t } = useI18n();
  const row = props.row;
  const connection = row.connection;
  const active = row.closedAt === null;
  const chain = [...connection.chainList].reverse();
  const created = Number(connection.createdAt);
  const open = () => props.onOpen(connection.id);
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx(styles.grid, styles.row, !active && styles.closed)}
      onClick={open}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          open();
        }
      }}
    >
      <span className={styles.network}>
        <Badge>{connection.network.toUpperCase()}</Badge>
      </span>
      <span className={styles.cell}>
        <span className={styles.destination}>{connection.domain || connection.destination}</span>
        <span className={styles.sub}>
          {connection.inboundType}/{connection.inbound}
          {connection.domain !== "" && connection.destination !== "" ? ` · ${connection.destination}` : ""}
        </span>
      </span>
      <span className={styles.cell} title={chain.join(" › ")}>
        <span className={styles.chain}>{chain[chain.length - 1] ?? connection.outbound}</span>
        <span className={styles.sub}>{[chain.slice(0, -1).join(" › "), connection.rule].filter((part) => part !== "").join(" · ")}</span>
      </span>
      <span className={cx(styles.cell, styles.num)}>
        {active ? (
          <>
            <span>↑ {formatBytes(row.uplinkRate)}/s</span>
            <span>↓ {formatBytes(row.downlinkRate)}/s</span>
          </>
        ) : (
          <span className={styles.sub}>—</span>
        )}
      </span>
      <span className={cx(styles.cell, styles.num)}>
        <span>↑ {formatBytes(row.uplinkTotal)}</span>
        <span>↓ {formatBytes(row.downlinkTotal)}</span>
      </span>
      <span className={cx(styles.cell, styles.num)}>
        <span>{formatDurationMs(Math.max(0, (row.closedAt ?? props.now) - created))}</span>
        <span className={styles.sub}>{formatClockTime(created)}</span>
      </span>
      <span className={styles.action}>
        {active ? (
          <IconButton
            title={t("Close connection")}
            onClick={(event) => {
              event.stopPropagation();
              props.onCloseConnection(connection.id);
            }}
          >
            <Icon name="close" size={14} />
          </IconButton>
        ) : null}
      </span>
    </div>
  );
});

function ConnectionDetailBody(props: { row: ConnectionRow; onClose: () => void }) {
  const api = useApi();
  const { t, language } = useI18n();
  const row = props.row;
  const connection = row.connection;
  const active = row.closedAt === null;
  const chain = [...connection.chainList].reverse();
  return (
    <>
      <div className="hint" style={{ fontFamily: "var(--font-mono)" }}>
        {connection.id}
      </div>
      <DetailSection title={t("Traffic")}>
        <Line label={t("Created at")} value={formatDateTime(Number(connection.createdAt), language)} />
        {row.closedAt !== null && (
          <Line label={t("Closed at")} value={formatDateTime(row.closedAt, language)} />
        )}
        <Line label={t("Uplink")} value={formatBytes(row.uplinkTotal)} />
        <Line label={t("Downlink")} value={formatBytes(row.downlinkTotal)} />
      </DetailSection>
      <DetailSection title={t("Metadata")}>
        <Line label={t("Inbound")} value={connection.inbound} />
        <Line label={t("Inbound type")} value={connection.inboundType} />
        <Line label={t("IP version")} value={connection.ipVersion > 0 ? `IPv${connection.ipVersion}` : ""} />
        <Line label={t("Network")} value={connection.network.toUpperCase()} />
        <Line label={t("Source")} value={connection.source} />
        <Line label={t("Destination")} value={connection.destination} />
        <Line label={t("Domain")} value={connection.domain} />
        <Line label={t("Protocol")} value={connection.protocol} />
        <Line label={t("User")} value={connection.user} />
        <Line label={t("From outbound")} value={connection.fromOutbound} />
        <Line label={t("Match rule")} value={connection.rule} />
        <Line label={t("Outbound")} value={connection.outbound} />
        <Line label={t("Outbound type")} value={connection.outboundType} />
        {chain.length > 1 && <Line label={t("Chain")} value={chain.join(" / ")} />}
      </DetailSection>
      {connection.processInfo && (
        <DetailSection title={t("Process")}>
          <Line
            label={t("Process")}
            value={`${connection.processInfo.processPath} (${connection.processInfo.processId})`}
          />
          <Line label={t("User")} value={connection.processInfo.userName} />
        </DetailSection>
      )}
      {active && (
        <>
          <hr className={styles.divider} />
          <div className="row-actions">
            <Button
              variant="danger"
              onClick={() => {
                void api.closeConnection(connection.id).catch(showError);
                props.onClose();
              }}
            >
              <Icon name="close" size={13} />
              {t("Close connection")}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function Line(props: { label: string; value: string }) {
  if (props.value === "") {
    return null;
  }
  return <DataLine label={props.label} value={props.value} mono />;
}
