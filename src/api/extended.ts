import type { Client, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";

import {
  ExtendedService,
  type DNSQueryLogEntry,
  type DNSQueryLogPage,
  type DNSQueryLogStats,
  type DNSQueryLogStatus,
  type OutboundProviderStatus,
} from "../gen/daemon/extended_service_pb";
import { StreamStore } from "./stream";

// ExtendedService is served only by fl0w1nd/sing-box. Against an upstream
// core every call fails with Unimplemented, which callers treat as "no
// extension" rather than an error.

export type ExtensionName =
  | "outbound_provider"
  | "tailscale_force_relay"
  | "dns_query_log"
  | "dns_cache";

export interface ExtensionCapabilities {
  ready: boolean;
  versions: Partial<Record<ExtensionName, number>>;
}

export interface ProvidersData {
  providers: OutboundProviderStatus[];
  loaded: boolean;
}

export interface ForceRelayData {
  enabled: boolean;
  loaded: boolean;
}

export interface DNSQueryFilter {
  search?: string;
  queryType?: string;
  status?: string;
  server?: string;
  inbound?: string;
  since?: number;
  until?: number;
}

export class ExtendedApi {
  readonly client: Client<typeof ExtendedService>;
  readonly providers: StreamStore<ProvidersData>;
  readonly forceRelay: StreamStore<ForceRelayData>;
  private capabilitiesPromise: Promise<ExtensionCapabilities> | null = null;

  constructor(transport: Transport) {
    this.client = createClient(ExtendedService, transport);

    this.providers = new StreamStore<ProvidersData>(
      () => ({ providers: [], loaded: false }),
      async ({ signal, update }) => {
        await this.require("outbound_provider");
        for await (const message of this.client.subscribeOutboundProviders({}, { signal })) {
          update(() => ({ providers: message.providers, loaded: true }));
        }
      },
    );

    this.forceRelay = new StreamStore<ForceRelayData>(
      () => ({ enabled: false, loaded: false }),
      async ({ signal, update }) => {
        await this.require("tailscale_force_relay");
        for await (const message of this.client.subscribeTailscaleForceRelayStatus({}, { signal })) {
          update(() => ({ enabled: message.enabled, loaded: true }));
        }
      },
    );
  }

  capabilities(): Promise<ExtensionCapabilities> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.client.getCapabilities({}).then(
        (response) => {
          const versions: ExtensionCapabilities["versions"] = {};
          for (const capability of response.capabilities) {
            versions[capability.name as ExtensionName] = capability.version;
          }
          return { ready: true, versions };
        },
        (error: unknown) => {
          if (error instanceof ConnectError && error.code === Code.Unimplemented) {
            return { ready: true, versions: {} };
          }
          this.capabilitiesPromise = null;
          throw error;
        },
      );
    }
    return this.capabilitiesPromise;
  }

  private async require(name: ExtensionName): Promise<void> {
    const capabilities = await this.capabilities();
    if (capabilities.versions[name] === undefined) {
      throw new ConnectError(`the core does not support ${name}`, Code.Unimplemented);
    }
  }

  retryNow(): void {
    this.providers.retryNow();
    this.forceRelay.retryNow();
  }

  reconnectNow(): void {
    this.providers.reconnectNow();
    this.forceRelay.reconnectNow();
  }

  async updateProvider(tag: string): Promise<void> {
    await this.client.updateOutboundProvider({ tag });
  }

  async setForceRelay(enabled: boolean): Promise<void> {
    await this.client.setTailscaleForceRelay({ enabled });
  }

  async dnsLogStatus(): Promise<DNSQueryLogStatus> {
    return await this.client.getDNSQueryLogStatus({});
  }

  async queryDnsLog(
    filter: DNSQueryFilter,
    before: bigint,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DNSQueryLogPage> {
    return await this.client.queryDNSQueryLog(
      { ...toRequest(filter), before, limit },
      { signal },
    );
  }

  async dnsLogStats(
    filter: DNSQueryFilter,
    bucketSeconds: number,
    top: number,
    signal?: AbortSignal,
  ): Promise<DNSQueryLogStats> {
    return await this.client.getDNSQueryLogStats(
      { filter: toRequest(filter), bucket: BigInt(bucketSeconds), top },
      { signal },
    );
  }

  async *followDnsLog(filter: DNSQueryFilter, signal: AbortSignal): AsyncGenerator<DNSQueryLogEntry> {
    yield* this.client.subscribeDNSQueryLog(toRequest(filter), { signal });
  }

  async clearDnsLog(): Promise<void> {
    await this.client.clearDNSQueryLog({});
  }

  async clearDnsCache(): Promise<void> {
    await this.client.clearDNSCache({});
  }
}

function toRequest(filter: DNSQueryFilter) {
  return {
    search: filter.search ?? "",
    queryType: filter.queryType ?? "",
    status: filter.status ?? "",
    server: filter.server ?? "",
    inbound: filter.inbound ?? "",
    since: BigInt(filter.since ?? 0),
    until: BigInt(filter.until ?? 0),
  };
}
