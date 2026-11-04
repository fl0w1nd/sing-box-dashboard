import type { ExtensionCapabilities, ExtensionName } from "../api/extended";
import { createContext, useContext } from "react";

export const MIN_API_VERSION = {
  usbip: 2,
  openVpnAndOpenConnect: 3,
  taildrop: 4,
} as const;

export type Capability = keyof typeof MIN_API_VERSION;

export interface ServerCapabilities {
  ready: boolean;
  supports(capability: Capability): boolean;
}

export function makeCapabilities(apiVersion: number | null): ServerCapabilities {
  return {
    ready: apiVersion !== null,
    supports: (capability) => apiVersion !== null && apiVersion >= MIN_API_VERSION[capability],
  };
}

export const CapabilitiesContext = createContext<ServerCapabilities>(makeCapabilities(null));

export function useSupportsCapability(capability: Capability): boolean {
  return useContext(CapabilitiesContext).supports(capability);
}

export const ExtensionsContext = createContext<ExtensionCapabilities>({ ready: false, versions: {} });

export function useExtension(name: ExtensionName): boolean {
  return useContext(ExtensionsContext).versions[name] !== undefined;
}

export function useExtensions(): ExtensionCapabilities {
  return useContext(ExtensionsContext);
}
