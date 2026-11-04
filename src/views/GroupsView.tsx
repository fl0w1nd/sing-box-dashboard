import { useRef, useState } from "react";

import { proxyDisplayType, splitNodeTag, urlTestDelayTone } from "../api/format";
import { useStream } from "../api/stream";
import { useApi } from "../app/context";
import { loadStoredString, saveStoredString } from "../lib/storage";
import { showError } from "../app/errorStore";
import { usePendingValue } from "../app/hooks";
import { useI18n } from "../app/i18n";
import { Board, Panel } from "../components/Board";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamStates } from "../components/StreamBanner";
import { Button, IconButton, MenuItem, SearchInput, Spinner, useContextMenu, useCopy } from "../components/ui";
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
  const [sort, setSortState] = useState<NodeSort>(() => parseSort(loadStoredString(SORT_KEY)));
  const setSort = (value: NodeSort) => {
    saveStoredString(SORT_KEY, value);
    setSortState(value);
  };
  const allExpanded = groups.data.groups.length > 0 && groups.data.groups.every((group) => group.isExpand);
  const setAllExpanded = (expand: boolean) => {
    Promise.all(
      groups.data.groups
        .filter((group) => group.isExpand !== expand)
        .map((group) => api.setGroupExpand(group.tag, expand)),
    ).catch(showError);
  };

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
        <div className={styles.search}>
          <SearchInput value={search} onChange={setSearch} />
        </div>
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
        <Button
          className={styles.expandAll}
          disabled={groups.data.groups.length === 0}
          onClick={() => setAllExpanded(!allExpanded)}
        >
          <Icon name={allExpanded ? "unfold_less" : "unfold_more"} />
          {allExpanded ? t("Collapse all") : t("Expand all")}
        </Button>
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
            <GroupPanel key={group.tag} group={group} query={query} sort={sort} />
          ))}
        </Board>
      )}
    </div>
  );
}

type NodeSort = "default" | "latency" | "name";

const SORT_KEY = "groups-sort";

const SORTS = [
  { value: "default", label: "Default" },
  { value: "latency", label: "Latency" },
  { value: "name", label: "Name" },
] as const satisfies readonly { value: NodeSort; label: string }[];

function parseSort(value: string | null): NodeSort {
  return value === "latency" || value === "name" ? value : "default";
}

function sortItems(items: GroupItem[], sort: NodeSort): GroupItem[] {
  if (sort === "default") {
    return items;
  }
  const sorted = [...items];
  if (sort === "latency") {
    const key = (item: GroupItem) => (item.urlTestDelay > 0 ? item.urlTestDelay : Infinity);
    sorted.sort((a, b) => key(a) - key(b));
  } else {
    sorted.sort((a, b) => splitNodeTag(a.tag).name.localeCompare(splitNodeTag(b.tag).name));
  }
  return sorted;
}

function matches(item: GroupItem, query: string) {
  return query === "" || item.tag.toLowerCase().includes(query) || item.type.toLowerCase().includes(query);
}

function GroupPanel(props: { group: Group; query: string; sort: NodeSort }) {
  const api = useApi();
  const { t } = useI18n();
  const group = props.group;
  const [testing, setTesting] = useState(false);
  const [expanded, setExpandOverride] = usePendingValue(group.isExpand);
  const [selected, setPendingSelection, switching] = usePendingValue(group.selected);
  const items = group.items.filter((item) => matches(item, props.query));
  const groupMatches = props.query !== "" && group.tag.toLowerCase().includes(props.query);
  const visibleItems = sortItems(groupMatches ? group.items : items, props.sort);
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
          <span className={styles.groupSelected} aria-busy={switching || undefined}>
            {switching ? <Spinner /> : <Icon name="keyboard_arrow_right" size={13} />}
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
              switching={switching && item.tag === selected}
              selectable={group.selectable}
              onSelect={() => selectItem(item)}
            />
          ))}
        </div>
      ) : (
        <DotStrip items={group.items} selected={selected} onExpand={toggleExpand} />
      )}
    </Panel>
  );
}

function DotStrip(props: { items: GroupItem[]; selected: string; onExpand: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState<{ item: GroupItem; left: number; top: number } | null>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={styles.dotStrip}
      onClick={props.onExpand}
      onPointerLeave={() => setHover(null)}
      aria-label={t("Expand")}
    >
      {props.items.map((item) => {
        const tone = item.urlTestDelay > 0 ? urlTestDelayTone(item.urlTestDelay) : "none";
        return (
          <span
            key={item.tag}
            className={cx(styles.dot, styles[tone], item.tag === props.selected && styles.dotSelected)}
            onPointerEnter={(event) => {
              const strip = ref.current?.getBoundingClientRect();
              const dot = event.currentTarget.getBoundingClientRect();
              if (strip) {
                setHover({ item, left: dot.left - strip.left + dot.width / 2, top: dot.top - strip.top });
              }
            }}
          />
        );
      })}
      {hover && (
        <span className={cx("tooltip-card", styles.dotTip)} style={{ left: hover.left, top: hover.top }}>
          <span>{hover.item.tag}</span>
          <span className={cx(styles.delay, styles[hover.item.urlTestDelay > 0 ? urlTestDelayTone(hover.item.urlTestDelay) : "none"])}>
            {hover.item.urlTestDelay > 0 ? `${hover.item.urlTestDelay} ms` : t("No result")}
          </span>
        </span>
      )}
    </button>
  );
}

function NodeTile(props: {
  item: GroupItem;
  selected: boolean;
  switching: boolean;
  selectable: boolean;
  onSelect: () => void;
}) {
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
      <MenuItem
        icon={copied ? "check" : "content_copy"}
        onSelect={() => copy(item.tag)}
      >
        {t("Copy name")}
      </MenuItem>
    </>,
  );

  return (
    <>
      <div
        className={cx(
          styles.node,
          props.selected && styles.nodeSelected,
          props.switching && styles.nodeSwitching,
          !props.selectable && styles.nodeStatic,
        )}
        aria-busy={props.switching || undefined}
        {...menu.triggerProps}
      >
        {props.switching && <Spinner className={styles.nodeSpinner} />}
        <button type="button" className={styles.nodeMain} aria-pressed={props.selected} onClick={props.onSelect}>
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
                {item.urlTestDelay > 0 ? `${item.urlTestDelay}` : "—"}
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
