import { useState } from "react";

import { proxyDisplayType, splitNodeTag, urlTestDelayTone } from "../api/format";
import { useStream } from "../api/stream";
import { useApi } from "../app/context";
import { showError } from "../app/errorStore";
import { usePendingValue } from "../app/hooks";
import { useI18n } from "../app/i18n";
import { Board, Panel } from "../components/Board";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamStates } from "../components/StreamBanner";
import { Button, IconButton, MenuItem, SearchInput, Spinner, useContextMenu } from "../components/ui";
import type { Group, GroupItem } from "../gen/daemon/started_service_pb";
import styles from "./GroupsView.module.css";
import { cx } from "../lib/cx";

export function GroupsView() {
  const api = useApi();
  const { t } = useI18n();
  const groups = useStream(api.groups);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const [testingAll, setTestingAll] = useState(false);

  return (
    <div className="page">
      <PageHeader
        title={t("Groups")}
        actions={
          <Button
            disabled={testingAll || groups.data.groups.length === 0}
            onClick={() => {
              setTestingAll(true);
              Promise.all(groups.data.groups.map((group) => api.urlTest(group.tag)))
                .catch(showError)
                .finally(() => setTestingAll(false));
            }}
          >
            {testingAll ? <Spinner /> : <Icon name="bolt" />}
            {t("Test all")}
          </Button>
        }
      />
      <div className={styles.toolbar}>
        <SearchInput value={search} onChange={setSearch} />
      </div>
      <StreamStates
        snapshot={groups}
        loaded={groups.data.loaded}
        empty={groups.data.groups.length === 0}
        emptyIcon="folder"
        emptyMessage={t("Empty groups")}
      />
      {groups.data.groups.length > 0 && (
        <Board>
          {groups.data.groups.map((group) => (
            <GroupPanel key={group.tag} group={group} query={query} />
          ))}
        </Board>
      )}
    </div>
  );
}

function matches(item: GroupItem, query: string) {
  return query === "" || item.tag.toLowerCase().includes(query) || item.type.toLowerCase().includes(query);
}

function GroupPanel(props: { group: Group; query: string }) {
  const api = useApi();
  const { t } = useI18n();
  const group = props.group;
  const [testing, setTesting] = useState(false);
  const [expanded, setExpandOverride] = usePendingValue(group.isExpand);
  const [selected, setPendingSelection] = usePendingValue(group.selected);
  const items = group.items.filter((item) => matches(item, props.query));
  const groupMatches = props.query !== "" && group.tag.toLowerCase().includes(props.query);
  const visibleItems = groupMatches ? group.items : items;
  const open = expanded || (props.query !== "" && visibleItems.length > 0);
  const selectedItem = group.items.find((item) => item.tag === selected);
  const selectedSplit = selected !== "" ? splitNodeTag(selected) : null;

  if (props.query !== "" && !groupMatches && items.length === 0) {
    return null;
  }

  const toggleExpand = () => {
    const next = !expanded;
    setExpandOverride(next);
    api.setGroupExpand(group.tag, next).catch(() => setExpandOverride(null));
  };

  const runURLTest = () => {
    setTesting(true);
    api
      .urlTest(group.tag)
      .catch(showError)
      .finally(() => setTesting(false));
  };

  const selectItem = (item: GroupItem) => {
    if (!group.selectable || item.tag === selected) {
      return;
    }
    setPendingSelection(item.tag);
    api.selectOutbound(group.tag, item.tag).catch((error: unknown) => {
      setPendingSelection(null);
      showError(error);
    });
  };

  return (
    <Panel className={styles.groupPanel}>
      <header className={styles.groupHead}>
        <button type="button" className={styles.groupToggle} aria-expanded={open} onClick={toggleExpand}>
          <Icon name={open ? "expand_less" : "expand_more"} size={16} />
          <span className={styles.groupTitle}>{group.tag}</span>
          <span className="badge outline">{proxyDisplayType(group.type)}</span>
          <span className={styles.groupCount}>{t("{count} nodes", { count: group.items.length })}</span>
        </button>
        {selectedSplit && (
          <span className={styles.groupSelected}>
            <Icon name="keyboard_arrow_right" size={13} />
            {selectedSplit.flag !== "" && <span>{selectedSplit.flag}</span>}
            <span className={styles.groupSelectedName}>{selectedSplit.name}</span>
            {selectedItem && selectedItem.urlTestDelay > 0 && (
              <span className={cx(styles.delay, styles[urlTestDelayTone(selectedItem.urlTestDelay)])}>
                {selectedItem.urlTestDelay} ms
              </span>
            )}
          </span>
        )}
        <IconButton title={t("URL test")} onClick={runURLTest} disabled={testing}>
          {testing ? <Spinner /> : <Icon name="speed" />}
        </IconButton>
      </header>
      {open ? (
        <div className={styles.nodeGrid}>
          {visibleItems.map((item) => (
            <NodeTile
              key={item.tag}
              item={item}
              selected={item.tag === selected}
              selectable={group.selectable}
              onSelect={() => selectItem(item)}
            />
          ))}
        </div>
      ) : (
        <button type="button" className={styles.dotStrip} onClick={toggleExpand} aria-label={t("Expand")}>
          {group.items.map((item) => {
            const tone = item.urlTestDelay > 0 ? urlTestDelayTone(item.urlTestDelay) : "none";
            return (
              <span
                key={item.tag}
                className={cx(styles.dot, styles[tone], item.tag === selected && styles.dotSelected)}
                title={`${item.tag}${item.urlTestDelay > 0 ? ` (${item.urlTestDelay} ms)` : ""}`}
              />
            );
          })}
        </button>
      )}
    </Panel>
  );
}

function NodeTile(props: { item: GroupItem; selected: boolean; selectable: boolean; onSelect: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const item = props.item;
  const split = splitNodeTag(item.tag);
  const tone = item.urlTestDelay > 0 ? urlTestDelayTone(item.urlTestDelay) : "none";
  const menu = useContextMenu(
    <>
      <MenuItem icon="speed" onSelect={() => api.urlTest(item.tag).catch(showError)}>
        {t("URL test")}
      </MenuItem>
      <MenuItem
        icon="content_copy"
        onSelect={() => {
          void navigator.clipboard.writeText(item.tag).catch(showError);
        }}
      >
        {t("Copy")}
      </MenuItem>
    </>,
  );

  return (
    <>
      <button
        type="button"
        className={cx(styles.node, props.selected && styles.nodeSelected, !props.selectable && styles.nodeStatic)}
        aria-pressed={props.selected}
        onClick={props.onSelect}
        {...menu.triggerProps}
      >
        <span className={styles.nodeName}>
          {split.flag !== "" && <span className={styles.nodeFlag}>{split.flag}</span>}
          <span className={styles.nodeLabel}>{split.name}</span>
        </span>
        <span className={styles.nodeMeta}>
          <span className={styles.nodeType}>
            {split.prefix !== "" ? `${split.prefix} · ` : ""}
            {proxyDisplayType(item.type)}
          </span>
          <span className={cx(styles.delay, styles[tone])}>
            <span className={styles.delayDot} />
            {item.urlTestDelay > 0 ? `${item.urlTestDelay}` : "—"}
          </span>
        </span>
      </button>
      {menu.element}
    </>
  );
}
