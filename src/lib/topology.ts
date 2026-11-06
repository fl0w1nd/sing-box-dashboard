// Traffic topology: folds the active connections into five columns and the
// paths between them.
//
//   source → inbound → group → exit → destination
//
// The group is the first outbound the rule picked when it is a group (the
// start of the chain), the exit is the outbound that dialed (the end of the
// chain). A connection whose rule picked an outbound directly skips the group
// column.

import type { ConnectionRow } from "../api/daemon";
import type { Connection, TailscaleEndpointStatus } from "../gen/daemon/started_service_pb";

export type TopologyColumn = "source" | "inbound" | "group" | "exit" | "destination";

export const TOPOLOGY_COLUMNS: TopologyColumn[] = ["source", "inbound", "group", "exit", "destination"];

export type SourceKind = "device" | "app" | "local" | "tailscale" | "internal";

export interface TopologyNode {
  key: string;
  column: TopologyColumn;
  label: string;
  // Source nodes: what the label names. Inbound and exit nodes: the
  // sing-box type.
  kind?: SourceKind;
  type?: string;
  destinationKind?: DestinationKind;
  // The outbound or inbound tag; empty for sources and folded nodes.
  tag: string;
  // Source nodes: the addresses seen for it.
  addresses: string[];
  conns: number;
  up: number;
  down: number;
  // The nodes folded into this one ("3 more").
  members?: TopologyNode[];
}

export interface TopologyPath {
  nodes: string[];
  conns: number;
  rate: number;
}

export interface TopologyConnection {
  row: ConnectionRow;
  // Node keys after folding, one per column the connection passes.
  nodes: string[];
  chain: string[];
}

export interface TopologyModel {
  columns: Record<TopologyColumn, TopologyNode[]>;
  paths: TopologyPath[];
  connections: TopologyConnection[];
  // Column order of this model; pass it back in so nodes keep their places.
  order: Partial<Record<TopologyColumn, string[]>>;
  totals: { conns: number; up: number; down: number };
}

export type DestinationKind = "local" | "lan" | "tailscale" | "internet" | "unknown";

function canonicalHost(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized.includes(":")) return normalized;
  try {
    const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join(".");
    }
    return canonical;
  } catch {
    return normalized;
  }
}

function destinationKind(connection: Connection, local: Set<string>, peers: Set<string>): DestinationKind {
  const host = canonicalHost(hostOf(connection.destination));
  const direct = connection.outboundType === "direct";
  if (local.has(host) || isLoopback(host)) return direct ? "local" : "unknown";
  if (peers.has(host)) return "tailscale";
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b, c] = octets.map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "lan";
    if (a === 100 && b >= 64 && b <= 127) return connection.outboundType === "tailscale" ? "tailscale" : "unknown";
    if (a === 0 || a >= 224 || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return "unknown";
    return "internet";
  }
  if (host.includes(":")) {
    try { new URL(`http://[${host}]/`); } catch { return "unknown"; }
    const first = parseInt(host.split(":")[0], 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) {
      return connection.outboundType === "tailscale" && host.startsWith("fd7a:115c:a1e0:") ? "tailscale" : "lan";
    }
    if ((first & 0xe000) === 0x2000 && !host.startsWith("2001:db8:")) return "internet";
  }
  return "unknown";
}

// Columns grow until these many nodes, then the quietest fold into one.
const LIMITS: Record<Exclude<TopologyColumn, "destination">, number> = {
  source: 8,
  inbound: 5,
  group: 8,
  exit: 8,
};

// Outbounds that do not leave the machine.
const LOCAL_EXIT_TYPES = new Set(["block", "dns"]);

export function nodeRate(node: { up: number; down: number }): number {
  return node.up + node.down;
}

// "1.2.3.4:5" / "[::1]:5" → host
export function hostOf(address: string): string {
  if (address.startsWith("[")) {
    const end = address.indexOf("]");
    return end > 0 ? address.slice(1, end) : address;
  }
  const colon = address.lastIndexOf(":");
  return colon > 0 && address.indexOf(":") === colon ? address.slice(0, colon) : address;
}

// Strips IPv4-mapped prefixes and zones so one device keeps one key.
export function normalizeHost(host: string): string {
  let value = host.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) {
    value = value.slice(0, zone);
  }
  if (value.startsWith("::ffff:") && value.includes(".")) {
    value = value.slice(7);
  }
  return value;
}

function isLoopback(host: string): boolean {
  return host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255);
}

export function processName(connection: Connection): string {
  const info = connection.processInfo;
  if (!info) {
    return "";
  }
  if (info.processPath !== "") {
    const parts = info.processPath.split(/[\\/]/);
    return parts[parts.length - 1] || info.processPath;
  }
  return info.packageNames[0] ?? "";
}

// The outbounds a connection passed, rule's pick first.
export function connectionChain(connection: Connection): string[] {
  if (connection.chainList.length > 0) {
    return [...connection.chainList].reverse();
  }
  return connection.outbound !== "" ? [connection.outbound] : [];
}

function sourceOf(connection: Connection): { key: string; label: string; kind: SourceKind; address: string } {
  const host = normalizeHost(hostOf(connection.source));
  if (connection.inboundType === "tailscale" && host !== "") {
    return { key: `ts:${host}`, label: host, kind: "tailscale", address: host };
  }
  // On a desktop every connection comes from the same address (the TUN
  // gateway or loopback); the process is what tells them apart.
  const process = processName(connection);
  if (process !== "") {
    return { key: `app:${process}`, label: process, kind: "app", address: host };
  }
  if (host === "") {
    return { key: "internal", label: "", kind: "internal", address: "" };
  }
  if (isLoopback(host)) {
    return { key: "local", label: "", kind: "local", address: host };
  }
  return { key: `ip:${host}`, label: host, kind: "device", address: host };
}

function rank(
  nodes: Map<string, TopologyNode>,
  limit: number,
  previous: string[] | undefined,
): { shown: TopologyNode[]; rest: TopologyNode[] } {
  const all = [...nodes.values()].sort(
    (left, right) =>
      nodeRate(right) - nodeRate(left) || right.conns - left.conns || left.label.localeCompare(right.label),
  );
  // One slot goes to the folded node, so folding never hides just one.
  const cut = all.length > limit ? limit - 1 : limit;
  const shown = all.slice(0, cut);
  const rest = all.slice(cut);
  // Keep last order so nodes do not jump around every second; newcomers
  // go below, busiest first.
  const keys = new Set(shown.map((node) => node.key));
  const kept = (previous ?? []).filter((key) => keys.has(key));
  const keptSet = new Set(kept);
  const byKey = new Map(shown.map((node) => [node.key, node]));
  const ordered = [
    ...kept.map((key) => byKey.get(key)!),
    ...shown.filter((node) => !keptSet.has(node.key)),
  ];
  return { shown: ordered, rest };
}

export function buildTopology(
  rows: Iterable<ConnectionRow>,
  previousOrder: Partial<Record<TopologyColumn, string[]>> = {},
  endpoints: TailscaleEndpointStatus[] = [],
): TopologyModel {
  const columns = {
    source: new Map<string, TopologyNode>(),
    inbound: new Map<string, TopologyNode>(),
    group: new Map<string, TopologyNode>(),
    exit: new Map<string, TopologyNode>(),
  };
  const node = (column: keyof typeof columns, key: string, init: Partial<TopologyNode>) => {
    let found = columns[column].get(key);
    if (!found) {
      found = { key, column, label: "", tag: "", addresses: [], conns: 0, up: 0, down: 0, ...init };
      columns[column].set(key, found);
    }
    return found;
  };

  const destinations = new Map<DestinationKind, TopologyNode>();
  const local = new Set(endpoints.flatMap((endpoint) => endpoint.self?.tailscaleIPs ?? []).map(canonicalHost));
  const peers = new Set(endpoints.flatMap((endpoint) => endpoint.userGroups.flatMap((group) => group.peers.flatMap((peer) => peer.tailscaleIPs))).map(canonicalHost));
  const connections: TopologyConnection[] = [];
  const totals = { conns: 0, up: 0, down: 0 };

  for (const row of rows) {
    if (row.closedAt !== null) {
      continue;
    }
    const connection = row.connection;
    const up = row.uplinkRate;
    const down = row.downlinkRate;
    const chain = connectionChain(connection);

    const source = sourceOf(connection);
    const sourceNode = node("source", source.key, { label: source.label, kind: source.kind });
    if (source.address !== "" && !sourceNode.addresses.includes(source.address)) {
      sourceNode.addresses.push(source.address);
    }
    const inboundNode = node("inbound", `in:${connection.inbound}`, {
      label: connection.inbound || connection.inboundType,
      tag: connection.inbound,
      type: connection.inboundType,
    });
    const groupTag = chain.length > 1 ? chain[0] : "";
    const groupNode = groupTag !== "" ? node("group", `g:${groupTag}`, { label: groupTag, tag: groupTag }) : null;
    const exitTag = chain[chain.length - 1] ?? connection.outbound;
    const exitNode = node("exit", `x:${exitTag}`, { label: exitTag, tag: exitTag, type: connection.outboundType });
    const leaves = !LOCAL_EXIT_TYPES.has(connection.outboundType);

    let destination: TopologyNode | null = null;
    if (leaves) {
      const kind = destinationKind(connection, local, peers);
      destination = destinations.get(kind) ?? {
        key: `destination:${kind}`, column: "destination", destinationKind: kind,
        label: "", tag: "", addresses: [], conns: 0, up: 0, down: 0,
      };
      destinations.set(kind, destination);
    }
    const passed = [sourceNode, inboundNode, groupNode, exitNode, destination].filter(
      (entry): entry is TopologyNode => entry !== null,
    );
    for (const entry of passed) {
      entry.conns += 1;
      entry.up += up;
      entry.down += down;
    }
    totals.conns += 1;
    totals.up += up;
    totals.down += down;
    connections.push({ row, nodes: passed.map((entry) => entry.key), chain });
  }

  const result: TopologyModel = {
    columns: { source: [], inbound: [], group: [], exit: [], destination: (["local", "lan", "tailscale", "internet", "unknown"] as const).flatMap((kind) => destinations.get(kind) ?? []) },
    paths: [],
    connections,
    order: {},
    totals,
  };

  const folded = new Map<string, string>();
  for (const column of ["source", "inbound", "group", "exit"] as const) {
    const { shown, rest } = rank(columns[column], LIMITS[column], previousOrder[column]);
    result.order[column] = shown.map((entry) => entry.key);
    if (rest.length > 0) {
      const other: TopologyNode = {
        key: `${column}:other`,
        column,
        label: "",
        tag: "",
        addresses: [],
        members: rest,
        conns: rest.reduce((sum, entry) => sum + entry.conns, 0),
        up: rest.reduce((sum, entry) => sum + entry.up, 0),
        down: rest.reduce((sum, entry) => sum + entry.down, 0),
      };
      for (const entry of rest) {
        folded.set(entry.key, other.key);
      }
      shown.push(other);
    }
    result.columns[column] = shown;
  }

  const paths = new Map<string, TopologyPath>();
  for (const entry of connections) {
    entry.nodes = entry.nodes.map((key) => folded.get(key) ?? key);
    const key = entry.nodes.join("|");
    let path = paths.get(key);
    if (!path) {
      path = { nodes: entry.nodes, conns: 0, rate: 0 };
      paths.set(key, path);
    }
    path.conns += 1;
    path.rate += entry.row.uplinkRate + entry.row.downlinkRate;
  }
  result.paths = [...paths.values()];
  return result;
}

export interface TopologyEdge {
  key: string;
  from: string;
  to: string;
  conns: number;
  rate: number;
}

// Adjacent node pairs over all paths, with what flows between them.
export function topologyEdges(paths: TopologyPath[]): TopologyEdge[] {
  const edges = new Map<string, TopologyEdge>();
  for (const path of paths) {
    for (let index = 0; index < path.nodes.length - 1; index++) {
      const from = path.nodes[index];
      const to = path.nodes[index + 1];
      const key = `${from}>${to}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { key, from, to, conns: 0, rate: 0 };
        edges.set(key, edge);
      }
      edge.conns += path.conns;
      edge.rate += path.rate;
    }
  }
  return [...edges.values()];
}

// The connections that pass a node; a folded node stands for its members.
export function connectionsThrough(model: TopologyModel, key: string): TopologyConnection[] {
  return model.connections.filter((entry) => entry.nodes.includes(key));
}
