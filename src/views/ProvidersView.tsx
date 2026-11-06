import { useMemo, useState } from "react";

import {
  formatAbbreviatedDateTime,
  formatBytes,
  formatRelativeTime,
  proxyDisplayType,
  splitNodeTag,
  urlTestDelayTone,
} from "../api/format";
import { useStream } from "../api/stream";
import { useApi, useNow } from "../app/context";
import { showError } from "../app/errorStore";
import { useI18n } from "../app/i18n";
import { IconTile, Meter } from "../components/Board";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamStates } from "../components/StreamBanner";
import {
  Badge,
  Button,
  MenuItem,
  SearchInput,
  Spinner,
  useContextMenu,
  useCopy,
} from "../components/ui";
import type { OutboundProviderItem, OutboundProviderStatus } from "../gen/daemon/extended_service_pb";
import { cx } from "../lib/cx";
import styles from "./ProvidersView.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;
const URL_TEST_CONCURRENCY = 8;
const INITIAL_NODE_LIMIT = 24;

type NodeSort = "default" | "latency" | "name";

const SORTS = [
  { value: "default", label: "Default" },
  { value: "latency", label: "Latency" },
  { value: "name", label: "Name" },
] as const satisfies readonly { value: NodeSort; label: string }[];

async function runLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await run(item).catch(() => {});
    }
  });
  await Promise.all(workers);
}

function splitUnit(text: string): [string, string] {
  const index = text.lastIndexOf(" ");
  return index > 0 ? [text.slice(0, index), text.slice(index + 1)] : [text, ""];
}

function sortNodes(items: OutboundProviderItem[], sort: NodeSort): OutboundProviderItem[] {
  if (sort === "default") {
    return items;
  }
  const copy = [...items];
  if (sort === "latency") {
    const key = (item: OutboundProviderItem) => (item.urlTestDelay > 0 ? item.urlTestDelay : Infinity);
    copy.sort((a, b) => key(a) - key(b));
  } else {
    copy.sort((a, b) => splitNodeTag(a.tag).name.localeCompare(splitNodeTag(b.tag).name));
  }
  return copy;
}

export function ProvidersView() {
  const api = useApi();
  const { t } = useI18n();
  const providers = useStream(api.extended.providers);
  const list = providers.data.providers;
  const [updatingAll, setUpdatingAll] = useState(false);

  return (
    <div className="page">
      <PageHeader
        title={t("Providers")}
        actions={
          <Button
            disabled={updatingAll || list.length === 0}
            onClick={() => {
              setUpdatingAll(true);
              Promise.allSettled(list.map((provider) => api.extended.updateProvider(provider.tag)))
                .then((results) => {
                  const failed = results.find((result) => result.status === "rejected");
                  if (failed && failed.status === "rejected") {
                    showError(failed.reason);
                  }
                })
                .finally(() => setUpdatingAll(false));
            }}
          >
            {updatingAll ? <Spinner /> : <Icon name="sync" />}
            {t("Update all")}
          </Button>
        }
      />
      <StreamStates
        snapshot={providers}
        loaded={providers.data.loaded}
        empty={list.length === 0}
        emptyIcon="provider"
        emptyMessage={t("No providers configured")}
      />
      {list.length > 0 && (
        <div className={styles.stack}>
          {list.map((provider) => (
            <ProviderCard key={provider.tag} provider={provider} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderCard(props: { provider: OutboundProviderStatus }) {
  const api = useApi();
  const { t, language } = useI18n();
  const now = useNow(30_000);
  const provider = props.provider;
  const [updating, setUpdating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<NodeSort>("default");
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const busy = updating || provider.updating;

  const info = provider.subscriptionInfo;
  const upload = info ? Number(info.upload) : 0;
  const download = info ? Number(info.download) : 0;
  const quota = info ? Number(info.total) : 0;
  const used = upload + download;
  const ratio = quota > 0 ? used / quota : 0;
  const [usedVal, usedUnit] = splitUnit(formatBytes(used));
  const expireAt = info && info.expireTime > 0n ? Number(info.expireTime) * 1000 : 0;
  const daysLeft = expireAt > 0 ? Math.ceil((expireAt - now) / DAY_MS) : null;

  const latencyStats = useMemo(() => {
    let good = 0;
    let medium = 0;
    let bad = 0;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    for (const item of provider.items) {
      const d = item.urlTestDelay;
      if (d > 0) {
        sum += d;
        if (d < min) min = d;
        if (d > max) max = d;
        const tone = urlTestDelayTone(d);
        if (tone === "good") good++;
        else if (tone === "medium") medium++;
        else bad++;
      }
    }
    const tested = good + medium + bad;
    const untested = Math.max(0, provider.items.length - tested);
    const avg = tested > 0 ? Math.round(sum / tested) : 0;
    return {
      tested,
      untested,
      good,
      medium,
      bad,
      avg,
      min: tested > 0 ? min : 0,
      max: tested > 0 ? max : 0,
    };
  }, [provider.items]);

  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const base =
      query === ""
        ? provider.items
        : provider.items.filter(
            (item) =>
              item.tag.toLowerCase().includes(query) || item.type.toLowerCase().includes(query),
          );
    return sortNodes(base, sort);
  }, [provider.items, query, sort]);

  const limit = showAll || query !== "" ? filtered.length : INITIAL_NODE_LIMIT;

  const update = () => {
    setUpdating(true);
    api.extended
      .updateProvider(provider.tag)
      .catch(showError)
      .finally(() => setUpdating(false));
  };

  const test = () => {
    setTesting(true);
    void runLimited(provider.items, URL_TEST_CONCURRENCY, (item) => api.urlTest(item.tag)).finally(
      () => setTesting(false),
    );
  };

  const updatedLabel =
    provider.updatedAt > 0n
      ? t("Updated {time}", {
          time: formatRelativeTime(Number(provider.updatedAt) * 1000, now, language),
        })
      : t("Never updated");

  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <IconTile icon="provider" />
        <div className={styles.headText}>
          <div className={styles.titleRow}>
            <span className={styles.title}>{provider.tag}</span>
            {provider.type !== "" && <Badge>{provider.type}</Badge>}
            <Badge tone="info">{t("{count} nodes", { count: provider.items.length })}</Badge>
          </div>
          <span className={styles.subtitle}>{updatedLabel}</span>
        </div>
        <div className={styles.headActions}>
          <Button
            size="small"
            disabled={testing || provider.items.length === 0}
            onClick={test}
          >
            {testing ? <Spinner /> : <Icon name="speed" size={13} />}
            {t("Test")}
          </Button>
          <Button size="small" disabled={busy} onClick={update}>
            {busy ? <Spinner /> : <Icon name="sync" size={13} />}
            {busy ? t("Updating...") : t("Update")}
          </Button>
          <Button
            size="small"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("Expand") : t("Collapse")}
            title={collapsed ? t("Expand") : t("Collapse")}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            <Icon name={collapsed ? "expand_more" : "expand_less"} size={15} />
          </Button>
        </div>
      </header>

      {provider.lastError !== "" && (
        <div className={cx("banner error", styles.errorBanner)}>
          <Icon name="warning_amber" />
          <div>
            <div className={styles.errorTitle}>{t("Last update failed")}</div>
            <div className={styles.errorText}>{provider.lastError}</div>
          </div>
        </div>
      )}

      <div className={styles.statsGrid}>
        {/* Box 1: Traffic Quota */}
        <div className={styles.statBox}>
          <div className={styles.statTop}>
            <span className={styles.statLabel}>{t("Traffic used")}</span>
            {quota > 0 && (
              <Badge tone={ratio > 0.85 ? "bad" : ratio > 0.7 ? "medium" : "info"}>
                {(ratio * 100).toFixed(1)}%
              </Badge>
            )}
          </div>
          {quota > 0 ? (
            <>
              <div className={styles.statMain}>
                <span className={styles.statValue}>{usedVal}</span>
                <span className={styles.statUnit}>{usedUnit}</span>
                <span className={styles.statSecondary}>/ {formatBytes(quota)}</span>
              </div>
              <Meter
                value={ratio}
                tone={ratio > 0.85 ? "warn" : undefined}
                label={t("Traffic used")}
              />
              <div className={styles.statFoot}>
                <span>
                  <span className="swatch up" /> ↑ <strong>{formatBytes(upload)}</strong>
                </span>
                <span>
                  <span className="swatch down" /> ↓ <strong>{formatBytes(download)}</strong>
                </span>
                <span>
                  {t("Remaining")} <strong>{formatBytes(Math.max(quota - used, 0))}</strong>
                </span>
              </div>
            </>
          ) : (
            <>
              <div className={styles.statMain}>
                <span className={styles.statValue}>—</span>
              </div>
              <div className={styles.statFoot}>{t("Not reported")}</div>
            </>
          )}
        </div>

        {/* Box 2: Expiration */}
        <div className={styles.statBox}>
          <div className={styles.statTop}>
            <span className={styles.statLabel}>{t("Expires")}</span>
            {daysLeft !== null && (
              <Badge tone={daysLeft <= 7 ? "bad" : daysLeft <= 14 ? "medium" : "good"}>
                { new Intl.DateTimeFormat(language, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }).format(expireAt) }
              </Badge>
            )}
          </div>
          {daysLeft !== null ? (
            <>
              <div className={styles.statMain}>
                <span className={cx(styles.statValue, daysLeft <= 7 && styles.expiring)}>
                  {Math.max(0, daysLeft)}
                </span>
                <span className={styles.statUnit}>{t("days")}</span>
                <span className={styles.statSecondary}>{t("Remaining")}</span>
              </div>
              <div className={styles.healthBar} aria-hidden="true">
                <span
                  className={
                    daysLeft <= 7
                      ? styles.healthBad
                      : daysLeft <= 14
                        ? styles.healthMedium
                        : styles.healthGood
                  }
                  style={{ flexGrow: Math.max(2, Math.min(30, Math.max(0, daysLeft))) }}
                />
                {daysLeft < 30 && (
                  <span
                    className={styles.healthNone}
                    style={{ flexGrow: Math.max(0, 30 - Math.max(0, daysLeft)) }}
                  />
                )}
              </div>
              <div className={styles.statFoot}>
                <span>{formatAbbreviatedDateTime(expireAt, language)}</span>
                <span>{updatedLabel}</span>
              </div>
            </>
          ) : (
            <>
              <div className={styles.statMain}>
                <span className={styles.statValue}>—</span>
              </div>
              <div className={styles.healthBar} aria-hidden="true">
                <span className={styles.healthNone} style={{ flexGrow: 1 }} />
              </div>
              <div className={styles.statFoot}>{updatedLabel}</div>
            </>
          )}
        </div>

        {/* Box 3: Nodes Latency & Health */}
        <div className={styles.statBox}>
          <div className={styles.statTop}>
            <span className={styles.statLabel}>{t("Latency")}</span>
            <Badge tone={latencyStats.tested > 0 ? "good" : "neutral"}>
              {latencyStats.tested} / {provider.items.length}
            </Badge>
          </div>
          <div className={styles.statMain}>
            <span className={styles.statValue}>
              {latencyStats.tested > 0 ? latencyStats.avg : "—"}
            </span>
            {latencyStats.tested > 0 && (
              <>
                <span className={styles.statUnit}>ms</span>
                <span className={styles.statSecondary}>{t("Average")}</span>
              </>
            )}
          </div>
          <div className={styles.healthBar} aria-hidden="true">
            {latencyStats.good > 0 && (
              <span className={styles.healthGood} style={{ flexGrow: latencyStats.good }} />
            )}
            {latencyStats.medium > 0 && (
              <span className={styles.healthMedium} style={{ flexGrow: latencyStats.medium }} />
            )}
            {latencyStats.bad > 0 && (
              <span className={styles.healthBad} style={{ flexGrow: latencyStats.bad }} />
            )}
            {latencyStats.untested > 0 && (
              <span className={styles.healthNone} style={{ flexGrow: latencyStats.untested }} />
            )}
          </div>
          <div className={styles.statFoot}>
            {latencyStats.tested > 0 ? (
              <>
                <span>
                  {t("Low")} <strong>{latencyStats.min} ms</strong>
                </span>
                <span>
                  {t("High")} <strong>{latencyStats.max} ms</strong>
                </span>
              </>
            ) : (
              <span>{t("No result")}</span>
            )}
          </div>
        </div>
      </div>

      {/* Nodes Section */}
      {!collapsed && (
        <>
          <div className={styles.nodesHead}>
            <div className={styles.nodesTitleWrap}>
              <span className="text-eyebrow">{t("Nodes")}</span>
              <span className="faint mono">{filtered.length}</span>
            </div>
            {provider.items.length > 0 && (
              <div className={styles.nodesControls}>
                {provider.items.length > 6 && (
                  <div className={styles.nodesSearch}>
                    <SearchInput value={search} onChange={setSearch} />
                  </div>
                )}
                <div className="segmented compact" role="radiogroup" aria-label={t("Sort")}>
                  {SORTS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={sort === option.value}
                      className={sort === option.value ? "active" : ""}
                      onClick={() => setSort(option.value)}
                    >
                      {t(option.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {provider.items.length === 0 ? (
            <div className={styles.noInfo}>{t("No nodes loaded yet.")}</div>
          ) : (
            <div className={styles.nodeGrid}>
              {filtered.slice(0, limit).map((item) => (
                <ProviderNodeTile key={item.tag} item={item} />
              ))}
            </div>
          )}

          {filtered.length > limit && (
            <button type="button" className={styles.moreButton} onClick={() => setShowAll(true)}>
              {t("Show {count} more", { count: filtered.length - limit })}
              <Icon name="expand_more" size={14} />
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ProviderNodeTile(props: { item: OutboundProviderItem }) {
  const api = useApi();
  const { t } = useI18n();
  const item = props.item;
  const split = splitNodeTag(item.tag);
  const tone = item.urlTestDelay > 0 ? urlTestDelayTone(item.urlTestDelay) : "none";
  const [testing, setTesting] = useState(false);
  const [copied, copy] = useCopy();

  const runTest = () => {
    setTesting(true);
    api
      .urlTest(item.tag)
      .catch(showError)
      .finally(() => setTesting(false));
  };

  const menu = useContextMenu(
    <>
      <MenuItem icon="speed" onSelect={runTest}>
        {t("URL test")}
      </MenuItem>
      <MenuItem icon={copied ? "check" : "content_copy"} onSelect={() => copy(item.tag)}>
        {t("Copy name")}
      </MenuItem>
    </>,
  );

  return (
    <>
      <div className={styles.nodeCard} title={item.tag} {...menu.triggerProps}>
        <button
          type="button"
          className={styles.nodeMain}
          onClick={() => copy(item.tag)}
          title={t("Copy name")}
        >
          <span className={styles.nodeName}>
            {split.flag !== "" && <span className={styles.nodeFlag}>{split.flag}</span>}
            <span className={styles.nodeLabel}>{split.name}</span>
          </span>
          <span className={styles.nodeType}>
            {split.prefix !== "" ? `${split.prefix} · ` : ""}
            {proxyDisplayType(item.type)}
          </span>
        </button>
        <button
          type="button"
          className={cx(styles.delay, styles.delayButton, styles[tone])}
          title={t("URL test")}
          aria-label={t("URL test")}
          disabled={testing}
          onClick={runTest}
        >
          {testing ? (
            <Spinner />
          ) : (
            <>
              <span className={styles.delayValue}>
                <span className={styles.delayDot} />
                {item.urlTestDelay > 0 ? `${item.urlTestDelay} ms` : "—"}
              </span>
              <Icon name="speed" size={13} className={styles.delayIcon} />
            </>
          )}
        </button>
      </div>
      {menu.element}
    </>
  );
}
