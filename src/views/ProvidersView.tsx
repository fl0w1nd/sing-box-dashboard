import { useState } from "react";

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
import { Board, Meter, Metric, Panel, PanelHead } from "../components/Board";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamStates } from "../components/StreamBanner";
import { Button, SearchInput, Spinner } from "../components/ui";
import type { OutboundProviderStatus } from "../gen/daemon/extended_service_pb";
import { cx } from "../lib/cx";
import styles from "./ProvidersView.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;
const URL_TEST_CONCURRENCY = 8;

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
        <Board>
          {list.map((provider) => (
            <ProviderPanel key={provider.tag} provider={provider} wide={list.length === 1} />
          ))}
        </Board>
      )}
    </div>
  );
}

function ProviderPanel(props: { provider: OutboundProviderStatus; wide: boolean }) {
  const api = useApi();
  const { t, language } = useI18n();
  const now = useNow(30_000);
  const provider = props.provider;
  const [updating, setUpdating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const busy = updating || provider.updating;

  const info = provider.subscriptionInfo;
  const upload = info ? Number(info.upload) : 0;
  const download = info ? Number(info.download) : 0;
  const quota = info ? Number(info.total) : 0;
  const used = upload + download;
  const ratio = quota > 0 ? used / quota : 0;
  const expireAt = info && info.expireTime > 0n ? Number(info.expireTime) * 1000 : 0;
  const daysLeft = expireAt > 0 ? Math.ceil((expireAt - now) / DAY_MS) : null;

  const query = search.trim().toLowerCase();
  const items = provider.items.filter((item) => query === "" || item.tag.toLowerCase().includes(query));
  const limit = showAll || query !== "" ? items.length : 24;

  const update = () => {
    setUpdating(true);
    api.extended
      .updateProvider(provider.tag)
      .catch(showError)
      .finally(() => setUpdating(false));
  };

  const test = () => {
    setTesting(true);
    void runLimited(provider.items, URL_TEST_CONCURRENCY, (item) => api.urlTest(item.tag)).finally(() =>
      setTesting(false),
    );
  };

  return (
    <Panel span={props.wide ? 12 : 6}>
      <PanelHead
        icon="provider"
        title={provider.tag}
        subtitle={
          <>
            {provider.type} · {t("{count} nodes", { count: provider.items.length })} ·{" "}
            {provider.updatedAt > 0n
              ? t("Updated {time}", {
                  time: formatRelativeTime(Number(provider.updatedAt) * 1000, now, language),
                })
              : t("Never updated")}
          </>
        }
        actions={
          <>
            <Button size="small" disabled={testing || provider.items.length === 0} onClick={test}>
              {testing ? <Spinner /> : <Icon name="speed" size={13} />}
              {t("Test")}
            </Button>
            <Button size="small" disabled={busy} onClick={update}>
              {busy ? <Spinner /> : <Icon name="sync" size={13} />}
              {busy ? t("Updating...") : t("Update")}
            </Button>
          </>
        }
      />
      {provider.lastError !== "" && (
        <div className="banner error">
          <Icon name="warning_amber" />
          <div>
            <div className={styles.errorTitle}>{t("Last update failed")}</div>
            <div className={styles.errorText}>{provider.lastError}</div>
          </div>
        </div>
      )}
      <div className={styles.summary}>
        <div className={styles.quota}>
          <div className="metric-label">{t("Traffic used")}</div>
          {quota > 0 ? (
            <>
              <div className={styles.quotaLine}>
                <Metric value={formatBytes(used).split(" ")[0]} unit={formatBytes(used).split(" ")[1]} size="medium" />
                <span className="faint mono">/ {formatBytes(quota)}</span>
                <span className={cx("mono", styles.quotaPercent, ratio > 0.85 && styles.quotaHigh)}>
                  {(ratio * 100).toFixed(1)}%
                </span>
              </div>
              <Meter value={ratio} tone={ratio > 0.85 ? "accent" : undefined} label={t("Traffic used")} />
              <div className={cx("metric-foot", styles.quotaFoot)}>
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
              <Metric value="—" size="medium" />
              <div className="metric-foot">{t("Not reported")}</div>
            </>
          )}
        </div>
        <div className={styles.facts}>
          <div>
            <div className="metric-label">{t("Expires")}</div>
            {daysLeft !== null ? (
              <>
                <Metric
                  value={daysLeft > 0 ? daysLeft : 0}
                  unit={t("days")}
                  size="medium"
                  className={cx(daysLeft <= 7 && styles.expiring)}
                />
                <div className="metric-foot">{formatAbbreviatedDateTime(expireAt, language)}</div>
              </>
            ) : (
              <Metric value="—" size="medium" />
            )}
          </div>
        </div>
      </div>
      <div className={styles.nodesHead}>
        <span className="text-eyebrow">{t("Nodes")}</span>
        {provider.items.length > 8 && (
          <div className={styles.nodesSearch}>
            <SearchInput value={search} onChange={setSearch} />
          </div>
        )}
      </div>
      {provider.items.length === 0 ? (
        <div className={styles.noInfo}>{t("No nodes loaded yet.")}</div>
      ) : (
        <div className={styles.nodes}>
          {items.slice(0, limit).map((item) => {
            const split = splitNodeTag(item.tag);
            const tone = item.urlTestDelay > 0 ? urlTestDelayTone(item.urlTestDelay) : "none";
            return (
              <div key={item.tag} className={styles.node} title={item.tag}>
                <span className={cx(styles.nodeDot, styles[tone])} />
                <span className={styles.nodeName}>
                  {split.flag !== "" && `${split.flag} `}
                  {split.name}
                </span>
                <span className={styles.nodeType}>{proxyDisplayType(item.type)}</span>
                <span className={cx(styles.nodeDelay, styles[tone])}>
                  {item.urlTestDelay > 0 ? item.urlTestDelay : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {items.length > limit && (
        <button type="button" className={styles.more} onClick={() => setShowAll(true)}>
          {t("Show {count} more", { count: items.length - limit })}
        </button>
      )}
    </Panel>
  );
}
