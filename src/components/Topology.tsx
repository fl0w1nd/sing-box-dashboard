import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatBytes, inboundDisplayType, proxyDisplayType, splitNodeTag } from "../api/format";
import { useI18n } from "../app/i18n";
import type { Group } from "../gen/daemon/started_service_pb";
import { cx } from "../lib/cx";
import {
  nodeRate,
  topologyEdges,
  type TopologyColumn,
  type TopologyModel,
  type TopologyNode,
} from "../lib/topology";
import { Icon, type IconName } from "./Icon";
import styles from "./Topology.module.css";

export function useTopologyLabel(): (node: TopologyNode) => string {
  const { t } = useI18n();
  return useCallback(
    (node: TopologyNode) => {
      if (node.members) {
        return t("{count} more", { count: node.members.length });
      }
      if (node.column === "internet") {
        return t("Internet");
      }
      if (node.kind === "local") {
        return t("Localhost");
      }
      if (node.kind === "internal") {
        return "sing-box";
      }
      return node.label;
    },
    [t],
  );
}

function topologyIcon(node: TopologyNode): IconName {
  switch (node.column) {
    case "source":
      switch (node.kind) {
        case "app":
          return "box";
        case "tailscale":
          return "waypoints";
        case "internal":
          return "cpu";
        default:
          return "computer";
      }
    case "inbound":
      return "download";
    case "group":
      return "folder";
    case "exit":
      if (node.members) {
        return "node";
      }
      return node.type === "direct" ? "upload" : node.type === "block" ? "close" : node.type === "dns" ? "dns" : "node";
    default:
      return "dns";
  }
}

function rate(value: number): string {
  return `${formatBytes(value)}/s`;
}

// Edge width follows the traffic on a log scale so one download does not
// drown the rest.
function strokeWidth(value: number): number {
  return value > 0 ? 1.5 + Math.min(4, Math.log10(1 + value / 2048) * 1.6) : 1;
}

interface Anchor {
  left: { x: number; y: number };
  right: { x: number; y: number };
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = Math.max(24, (to.x - from.x) / 2);
  return `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
}

export function Topology(props: {
  model: TopologyModel;
  groups: Group[];
  core: ReactNode;
  selected: string | null;
  onSelect: (node: TopologyNode) => void;
}) {
  const { t } = useI18n();
  const label = useTopologyLabel();
  const { model } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [anchors, setAnchors] = useState<{ map: Map<string, Anchor>; width: number; height: number; signature: string }>(
    { map: new Map(), width: 0, height: 0, signature: "" },
  );
  const [hover, setHover] = useState<string | null>(null);
  const [resized, setResized] = useState(0);

  const groupsByTag = useMemo(() => new Map(props.groups.map((group) => [group.tag, group])), [props.groups]);
  const edges = useMemo(() => topologyEdges(model.paths), [model.paths]);

  // Measure after every layout: node heights change with their text, and
  // nodes come and go with the connections.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const base = canvas.getBoundingClientRect();
    const map = new Map<string, Anchor>();
    const parts: string[] = [];
    for (const [key, element] of nodeRefs.current) {
      const rect = element.getBoundingClientRect();
      const y = Math.round(rect.top - base.top + rect.height / 2);
      const left = Math.round(rect.left - base.left);
      const right = Math.round(rect.right - base.left);
      map.set(key, { left: { x: left, y }, right: { x: right, y } });
      parts.push(`${key}:${left},${right},${y}`);
    }
    const width = Math.round(base.width);
    const height = Math.round(base.height);
    const signature = `${width}x${height}|${parts.join(";")}`;
    setAnchors((previous) => (previous.signature === signature ? previous : { map, width, height, signature }));
  }, [model, resized]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver(() => setResized((value) => value + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const lit = useMemo(() => {
    if (hover === null) {
      return null;
    }
    const nodes = new Set<string>([hover]);
    const links = new Set<string>();
    for (const path of model.paths) {
      if (!path.nodes.includes(hover)) {
        continue;
      }
      path.nodes.forEach((key, index) => {
        nodes.add(key);
        if (index > 0) {
          links.add(`${path.nodes[index - 1]}>${key}`);
        }
      });
    }
    return { nodes, links };
  }, [hover, model.paths]);

  const columnRate = (column: TopologyColumn) =>
    model.columns[column].reduce((sum, node) => sum + nodeRate(node), 0);

  const registerNode = (key: string) => (element: HTMLElement | null) => {
    if (element) {
      nodeRefs.current.set(key, element);
    } else {
      nodeRefs.current.delete(key);
    }
  };

  const renderNode = (node: TopologyNode, total: number) => {
    const value = nodeRate(node);
    const busy = value > 0;
    let meta: ReactNode = null;
    let name: ReactNode = label(node);
    if (node.column === "inbound" && node.type) {
      meta = inboundDisplayType(node.type);
    } else if (node.column === "group" && !node.members) {
      const group = groupsByTag.get(node.tag);
      if (group && group.selected !== "") {
        const split = splitNodeTag(group.selected);
        meta = (
          <>
            {split.flag !== "" && <span className={styles.flag}>{split.flag}</span>}
            {split.name}
          </>
        );
      }
    } else if (node.column === "exit" && node.type && !node.members) {
      meta = node.type === "block" ? t("Blocked") : proxyDisplayType(node.type);
    } else if (node.column === "source" && node.kind === "tailscale") {
      meta = "Tailscale";
    }
    if ((node.column === "group" || node.column === "exit") && !node.members) {
      const split = splitNodeTag(node.label);
      name = (
        <>
          {split.flag !== "" && <span className={styles.flag}>{split.flag}</span>}
          {split.name}
        </>
      );
    }
    const title = node.members ? node.members.map(label).join("\n") : label(node);
    const dimmed = lit !== null && !lit.nodes.has(node.key);
    return (
      <button
        key={node.key}
        ref={registerNode(node.key)}
        type="button"
        className={cx(
          styles.node,
          busy && styles.busy,
          node.members && styles.folded,
          node.type === "block" && styles.blocked,
          lit?.nodes.has(node.key) && styles.lit,
          dimmed && styles.dim,
          props.selected === node.key && styles.selected,
        )}
        title={title}
        onPointerEnter={() => setHover(node.key)}
        onFocus={() => setHover(node.key)}
        onClick={() => props.onSelect(node)}
      >
        <span className={styles.nodeIcon}>
          <Icon name={topologyIcon(node)} size={14} />
        </span>
        <span className={styles.nodeText}>
          <span className={styles.nodeName}>{name}</span>
          <span className={styles.nodeLine}>
            <span className={styles.nodeSub}>
              {busy ? rate(value) : t("{count} conns", { count: node.conns })}
              {busy && <span className={styles.nodeCount}>· {node.conns}</span>}
            </span>
            {meta !== null && <span className={styles.nodeMeta}>{meta}</span>}
          </span>
        </span>
        {busy && total > 0 && (
          <span className={styles.share} style={{ width: `${Math.max(4, (value / total) * 100)}%` }} />
        )}
      </button>
    );
  };

  const renderColumn = (column: TopologyColumn, title: string) => {
    const total = columnRate(column);
    return (
      <div className={styles.column}>
        <div className={styles.columnTitle}>
          <span>{title}</span>
          {model.columns[column].length > 0 && column !== "internet" && (
            <span className={styles.columnCount}>{model.columns[column].length}</span>
          )}
        </div>
        <div className={styles.nodes}>
          {model.columns[column].length === 0 ? (
            <span className={styles.columnEmpty}>—</span>
          ) : (
            model.columns[column].map((node) => renderNode(node, total))
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={styles.scroll}>
      <div
        ref={canvasRef}
        className={styles.canvas}
        onPointerLeave={() => setHover(null)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setHover(null);
          }
        }}
      >
        <svg className={styles.edges} width={anchors.width} height={anchors.height} aria-hidden="true">
          {edges.map((edge) => {
            const from = anchors.map.get(edge.from);
            const to = anchors.map.get(edge.to);
            if (!from || !to) {
              return null;
            }
            const state = lit === null ? "" : lit.links.has(edge.key) ? styles.edgeLit : styles.edgeDim;
            return (
              <path
                key={edge.key}
                className={cx(styles.edge, edge.rate > 0 && styles.flow, state)}
                d={curve(from.right, to.left)}
                style={{ strokeWidth: strokeWidth(edge.rate) }}
              >
                <title>
                  {t("{count} connections", { count: edge.conns })}
                  {edge.rate > 0 ? ` · ${rate(edge.rate)}` : ""}
                </title>
              </path>
            );
          })}
        </svg>
        <div className={styles.grid}>
          {renderColumn("source", t("Sources"))}
          <div className={styles.core}>
            <div className={styles.coreHead}>{props.core}</div>
            <div className={styles.coreColumns}>
              {renderColumn("inbound", t("Inbound"))}
              {renderColumn("group", t("Groups"))}
              {renderColumn("exit", t("Exits"))}
            </div>
          </div>
          {renderColumn("internet", t("Upstream"))}
        </div>
      </div>
    </div>
  );
}
