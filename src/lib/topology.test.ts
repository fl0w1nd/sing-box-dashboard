import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import type { ConnectionRow } from "../api/daemon";
import { ConnectionSchema, ProcessInfoSchema, TailscaleEndpointStatusSchema } from "../gen/daemon/started_service_pb";
import { buildTopology, connectionsThrough, hostOf, normalizeHost, topologyEdges } from "./topology";

let sequence = 0;

function row(init: MessageInitShape<typeof ConnectionSchema> & { up?: number; down?: number; closed?: boolean }): ConnectionRow {
  const { up = 0, down = 0, closed = false, ...fields } = init;
  const connection = create(ConnectionSchema, {
    id: String(sequence++),
    inbound: "tun-in",
    inboundType: "tun",
    source: "192.168.1.10:50000",
    destination: "1.1.1.1:443",
    outbound: "direct",
    outboundType: "direct",
    ...fields,
  });
  return {
    connection,
    uplinkRate: up,
    downlinkRate: down,
    uplinkTotal: 0n,
    downlinkTotal: 0n,
    closedAt: closed ? 1 : null,
  };
}

describe("hostOf / normalizeHost", () => {
  it("strips ports and IPv4-mapped prefixes", () => {
    expect(hostOf("1.2.3.4:80")).toBe("1.2.3.4");
    expect(hostOf("[fe80::1%en0]:53")).toBe("fe80::1%en0");
    expect(hostOf("::1")).toBe("::1");
    expect(normalizeHost("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeHost("fe80::1%en0")).toBe("fe80::1");
  });
});

describe("buildTopology", () => {
  it("routes through the group the rule picked to the dialing outbound", () => {
    const model = buildTopology([
      row({ chainList: ["JP 01", "Proxy"], outbound: "JP 01", outboundType: "vless", down: 100 }),
      row({ chainList: ["direct"], up: 5 }),
      row({ chainList: ["block"], outbound: "block", outboundType: "block" }),
      row({ closed: true }),
    ]);
    expect(model.totals).toEqual({ conns: 3, up: 5, down: 100 });
    expect(model.columns.group.map((node) => node.key)).toEqual(["g:Proxy"]);
    expect(model.columns.exit.map((node) => node.key)).toEqual(["x:JP 01", "x:direct", "x:block"]);
    const proxied = model.paths.find((path) => path.nodes.includes("g:Proxy"));
    expect(proxied?.nodes).toEqual(["ip:192.168.1.10", "in:tun-in", "g:Proxy", "x:JP 01", "destination:internet"]);
    // Blocked connections stop at the exit.
    expect(model.paths.find((path) => path.nodes.includes("x:block"))?.nodes.at(-1)).toBe("x:block");
    expect(model.columns.destination[0].conns).toBe(2);
    expect(topologyEdges(model.paths).find((edge) => edge.key === "in:tun-in>x:direct")?.conns).toBe(1);
  });

  it("tells sources apart by process, tailnet peer and loopback", () => {
    const model = buildTopology([
      row({ source: "172.19.0.1:1000", processInfo: create(ProcessInfoSchema, { processPath: "/Applications/Safari.app/Contents/MacOS/Safari" }) }),
      row({ source: "172.19.0.1:1001", processInfo: create(ProcessInfoSchema, { processPath: "C:\\Apps\\curl.exe" }) }),
      row({ source: "100.64.0.2:1000", inboundType: "tailscale", inbound: "ts-ep" }),
      row({ source: "127.0.0.1:1000" }),
      row({ source: "[::ffff:192.168.1.10]:1000" }),
    ]);
    const keys = model.columns.source.map((node) => node.key).sort();
    expect(keys).toEqual(["app:Safari", "app:curl.exe", "ip:192.168.1.10", "local", "ts:100.64.0.2"]);
  });

  it("folds the quietest nodes and keeps the previous order", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({ source: `10.0.0.${index}:1`, down: (index + 1) * 10 }),
    );
    const first = buildTopology(rows);
    expect(first.columns.source).toHaveLength(8);
    const other = first.columns.source[7];
    expect(other.key).toBe("source:other");
    expect(other.members?.map((node) => node.key)).toEqual(["ip:10.0.0.2", "ip:10.0.0.1", "ip:10.0.0.0"]);
    expect(connectionsThrough(first, other.key)).toHaveLength(3);

    // 10.0.0.2 gets busier than everything: it is shown, but below the
    // nodes that were already there.
    rows[2] = row({ source: "10.0.0.2:1", down: 1000 });
    const second = buildTopology(rows, first.order);
    const shown = second.columns.source.map((node) => node.key);
    expect(shown.slice(0, 6)).toEqual(first.order.source!.filter((key) => key !== "ip:10.0.0.3"));
    expect(shown[6]).toBe("ip:10.0.0.2");
  });
});


describe("topology destinations", () => {
  it.each([
    ["127.0.0.1:443", "local"],
    ["[0:0:0:0:0:0:0:1]:443", "local"],
    ["[::ffff:7f00:1]:443", "local"],
    ["10.0.0.1:80", "lan"],
    ["172.16.0.1:80", "lan"],
    ["192.168.8.1:80", "lan"],
    ["169.254.1.1:80", "lan"],
    ["[fe80::1%en0]:80", "lan"],
    ["[fd00::1]:80", "lan"],
    ["1.1.1.1:443", "internet"],
    ["[2606:4700:4700::1111]:443", "internet"],
    ["100.64.0.1:80", "unknown"],
    ["example.com:443", "unknown"],
    ["", "unknown"],
    ["999.1.1.1:80", "unknown"],
    ["[::]:80", "unknown"],
    ["224.0.0.1:80", "unknown"],
  ])("classifies %s as %s", (destination, kind) => {
    const model = buildTopology([row({ destination })]);
    expect(model.columns.destination[0].destinationKind).toBe(kind);
  });

  it("separates Tailscale local access, peer access and exit-node internet traffic", () => {
    const endpoints = [create(TailscaleEndpointStatusSchema, {
      self: { tailscaleIPs: ["100.64.0.1"] },
      userGroups: [{ peers: [{ tailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] }] }],
    })];
    const inputs = [
      row({ inboundType: "tailscale", destination: "127.0.0.1:22", up: 1 }),
      row({ destination: "100.64.0.1:80", up: 2 }),
      row({ destination: "100.64.0.2:80", outboundType: "tailscale", up: 4 }),
      row({ destination: "[fd7a:115c:a1e0:0:0:0:0:2]:80", up: 8 }),
      row({ inboundType: "tailscale", destination: "1.1.1.1:443", up: 16 }),
      row({ destination: "100.64.0.99:80", up: 32 }),
    ];
    const model = buildTopology(inputs, {}, endpoints);
    expect(model.columns.destination.map(({ destinationKind, conns, up }) => ({ destinationKind, conns, up }))).toEqual([
      { destinationKind: "local", conns: 2, up: 3 },
      { destinationKind: "tailscale", conns: 2, up: 12 },
      { destinationKind: "internet", conns: 1, up: 16 },
      { destinationKind: "unknown", conns: 1, up: 32 },
    ]);
    expect(connectionsThrough(model, "destination:local").map(({ row }) => row)).toEqual(inputs.slice(0, 2));
    expect(model.totals).toEqual({ conns: 6, up: 63, down: 0 });
  });

  it("does not label a proxy's loopback destination as this machine", () => {
    const model = buildTopology([row({ destination: "127.0.0.1:80", outboundType: "socks" })]);
    expect(model.columns.destination[0].destinationKind).toBe("unknown");
  });

  it("stops DNS and blocked traffic at their exits", () => {
    const model = buildTopology([row({ outboundType: "dns" }), row({ outboundType: "block" })]);
    expect(model.columns.destination).toEqual([]);
    expect(model.paths.every((path) => path.nodes.at(-1)?.startsWith("x:"))).toBe(true);
  });
});
