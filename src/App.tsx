import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  loadServersState,
  saveServersState,
  serverDisplayName,
  type Server,
  type ServersState,
} from "./api/config";
import { DaemonApi } from "./api/daemon";
import type { ExtensionCapabilities } from "./api/extended";
import { formatDateTime, formatUptime, isHttpUrl } from "./api/format";
import { isTerminalCode, useStream } from "./api/stream";
import { ServiceStatus_Type, type DeprecatedWarning } from "./gen/daemon/started_service_pb";
import { CapabilitiesContext, ExtensionsContext, makeCapabilities } from "./app/capabilities";
import { ApiContext, applyTheme, navigate, useApi, useNow } from "./app/context";
import { loadDisableDeprecatedWarnings } from "./app/deprecatedWarnings";
import { dismissError, showError, useCurrentError } from "./app/errorStore";
import { useDismiss, useStreamOutage, useUnaryOnce } from "./app/hooks";
import { I18nProvider, useI18n, type Translate } from "./app/i18n";
import { BrandMark } from "./components/Board";
import { Icon, type IconName } from "./components/Icon";
import { PageHeaderContext } from "./components/PageHeader";
import { Brand, Button, Dialog, IconButton, Spinner, StateDot } from "./components/ui";
import { SSH_DEFAULT_TERMINAL_TYPE, SSH_DEFAULT_USERNAME } from "./lib/tailscaleSSH";
import { ConnectionErrorView } from "./views/ConnectionErrorView";
import { ConnectionsView } from "./views/ConnectionsView";
import { DnsView } from "./views/DnsView";
import { GroupsView } from "./views/GroupsView";
import { LogsView } from "./views/LogsView";
import { OverviewView } from "./views/OverviewView";
import { ProvidersView } from "./views/ProvidersView";
import {
  ServersView,
  SettingsView,
  TerminalConfigurationView,
  TerminalThemeEditorView,
  TerminalThemePickerView,
} from "./views/SettingsView";
import { SetupView } from "./views/SetupView";
import { NetworkQualityView, STUNTestView, ToolsView } from "./views/ToolsView";
import { TaildropNavBadge, TaildropView } from "./views/TaildropView";
import { TailscaleEndpointView } from "./views/TailscaleView";
import { TailscaleSSHView } from "./views/TerminalView";
import { UsbipView } from "./views/UsbipView";
import { OpenConnectView } from "./views/OpenConnectView";
import { OpenVPNView } from "./views/OpenVPNView";
import styles from "./App.module.css";
import { cx } from "./lib/cx";

export type Route =
  | { page: "overview" }
  | { page: "groups" }
  | { page: "providers" }
  | { page: "connections" }
  | { page: "dns" }
  | { page: "logs" }
  | { page: "tools" }
  | { page: "tools/network-quality" }
  | { page: "tools/stun" }
  | { page: "tools/tailscale"; tag: string }
  | { page: "tools/tailscale/ssh"; tag: string; peerID: string; username: string; terminalType: string }
  | { page: "tools/tailscale/taildrop"; tag: string }
  | { page: "tools/usbip"; tag: string }
  | { page: "tools/openconnect"; tag: string }
  | { page: "tools/openvpn"; tag: string }
  | { page: "settings" }
  | { page: "settings/preferences/terminal" }
  | { page: "settings/preferences/terminal/theme"; scheme: "light" | "dark" }
  | { page: "settings/preferences/terminal/custom"; scheme: "light" | "dark" }
  | { page: "settings/servers" };

function routeFromHash(locationHash: string): Route {
  const hash = locationHash.replace(/^#\/?/, "");
  const queryIndex = hash.indexOf("?");
  const query = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : "");
  const segments = (queryIndex >= 0 ? hash.slice(0, queryIndex) : hash)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  switch (segments[0]) {
    case "groups":
      return { page: "groups" };
    case "providers":
      return { page: "providers" };
    case "connections":
      return { page: "connections" };
    case "dns":
      return { page: "dns" };
    case "logs":
      return { page: "logs" };
    case "tools":
      switch (segments[1]) {
        case "network-quality":
          return { page: "tools/network-quality" };
        case "stun":
          return { page: "tools/stun" };
        case "tailscale":
          if (segments[3] === "ssh" && segments[4]) {
            return {
              page: "tools/tailscale/ssh",
              tag: segments[2] ?? "",
              peerID: segments[4],
              username: query.get("username") || SSH_DEFAULT_USERNAME,
              terminalType: query.get("terminalType") || SSH_DEFAULT_TERMINAL_TYPE,
            };
          }
          if (segments[3] === "taildrop") {
            return { page: "tools/tailscale/taildrop", tag: segments[2] ?? "" };
          }
          return { page: "tools/tailscale", tag: segments[2] ?? "" };
        case "usbip":
          return { page: "tools/usbip", tag: segments[2] ?? "" };
        case "openconnect":
          return { page: "tools/openconnect", tag: segments[2] ?? "" };
        case "openvpn":
          return { page: "tools/openvpn", tag: segments[2] ?? "" };
        default:
          return { page: "tools" };
      }
    case "settings":
      switch (segments[1]) {
        case "preferences":
          if (segments[2] === "terminal") {
            if (segments[3] === "theme" && (segments[4] === "light" || segments[4] === "dark")) {
              return { page: "settings/preferences/terminal/theme", scheme: segments[4] };
            }
            if (segments[3] === "custom" && (segments[4] === "light" || segments[4] === "dark")) {
              return { page: "settings/preferences/terminal/custom", scheme: segments[4] };
            }
            return { page: "settings/preferences/terminal" };
          }
          return { page: "settings" };
        case "servers":
          return { page: "settings/servers" };
        default:
          return { page: "settings" };
      }
    default:
      return { page: "overview" };
  }
}

function subscribeLocationHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function locationHashSnapshot(): string {
  return location.hash;
}

// Tools subpages that require the service to be started.
// Unlike network-quality/stun, they fall back to the tools list rather than
// overview when the service stops.
function isStartedOnlyToolsSubpage(page: string): boolean {
  return (
    page.startsWith("tools/tailscale") ||
    page.startsWith("tools/usbip") ||
    page.startsWith("tools/openconnect") ||
    page.startsWith("tools/openvpn")
  );
}

// The section shown in the page eyebrow for nested pages.
function routeSection(route: Route, t: Translate): string | null {
  if (route.page.startsWith("tools/")) {
    return t("Tools");
  }
  if (route.page.startsWith("settings/")) {
    return t("Settings");
  }
  return null;
}

const NO_EXTENSIONS: ExtensionCapabilities = { ready: false, versions: {} };

export function App() {
  return (
    <I18nProvider>
      <WebApp />
      <GlobalErrorDialog />
    </I18nProvider>
  );
}

function useAppState() {
  const [serversState, setServersState] = useState<ServersState>(() => loadServersState());
  const locationHash = useSyncExternalStore(
    subscribeLocationHash,
    locationHashSnapshot,
    locationHashSnapshot,
  );
  const route = useMemo(() => routeFromHash(locationHash), [locationHash]);

  useEffect(() => {
    applyTheme();
  }, []);

  const updateServers = (next: ServersState) => {
    saveServersState(next);
    setServersState(() => next);
  };

  return { serversState, updateServers, route };
}

function WebApp() {
  const state = useAppState();

  const activeServer =
    state.serversState.servers.find((server) => server.id === state.serversState.activeId) ?? null;

  useEffect(() => {
    if (!activeServer && location.hash !== "") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }, [activeServer]);

  if (!activeServer) {
    return (
      <SetupView
        onCreate={(server) => {
          state.updateServers({
            servers: [...state.serversState.servers, server],
            activeId: server.id,
          });
          navigate("overview");
        }}
      />
    );
  }

  return (
    <Shell
      key={activeServer.id}
      server={activeServer}
      serversState={state.serversState}
      onServersChange={state.updateServers}
      route={state.route}
    />
  );
}

function GlobalErrorDialog() {
  const { t } = useI18n();
  const message = useCurrentError();
  if (message === null) {
    return null;
  }
  return (
    <Dialog onClose={dismissError}>
      <h3>{t("Error")}</h3>
      <p className="dialog-message">{message}</p>
      <div className="row-actions dialog-actions">
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(message).catch(() => {});
          }}
        >
          {t("Copy")}
        </Button>
        <Button variant="primary" onClick={dismissError}>
          {t("Ok")}
        </Button>
      </div>
    </Dialog>
  );
}

interface ShellProps {
  server: Server;
  serversState: ServersState;
  onServersChange: (state: ServersState) => void;
  route: Route;
}

function Shell(props: ShellProps) {
  const { language } = useI18n();
  const [generation, setGeneration] = useState(0);
  const api = useMemo(
    () => new DaemonApi(props.server, language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.server, language, generation],
  );
  return (
    <ApiContext.Provider value={api}>
      <ShellContent {...props} onRetry={() => setGeneration(generation + 1)} />
    </ApiContext.Provider>
  );
}

function ShellContent(props: ShellProps & { onRetry: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const route = props.route;
  const serviceStatus = useStream(api.serviceStatus);
  const groups = useStream(api.groups);
  const [menuOpen, setMenuOpen] = useState(false);
  const reportedFatalError = useRef<string | null>(null);

  const serviceStatusType = serviceStatus.data.status?.status;
  const fatalError =
    serviceStatusType === ServiceStatus_Type.FATAL
      ? serviceStatus.data.status?.errorMessage || t("Service failed to start")
      : null;
  useEffect(() => {
    if (fatalError === null) {
      reportedFatalError.current = null;
      return;
    }
    if (reportedFatalError.current !== fatalError) {
      reportedFatalError.current = fatalError;
      showError(fatalError);
    }
  }, [fatalError]);

  const lostError = useStreamOutage(
    serviceStatus,
    isTerminalCode(serviceStatus.errorCode) || serviceStatus.data.status === null,
  );

  useEffect(() => {
    const kick = () => {
      if (!document.hidden) {
        api.reconnectNow();
      }
    };
    document.addEventListener("visibilitychange", kick);
    window.addEventListener("pageshow", kick);
    window.addEventListener("online", kick);
    return () => {
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("pageshow", kick);
      window.removeEventListener("online", kick);
    };
  }, [api]);

  const reachable = serviceStatus.phase === "active";
  const serverInfo = useUnaryOnce(() => api.serverInfo(), reachable);
  const capabilities = useMemo(
    () => makeCapabilities(serverInfo?.apiVersion ?? null),
    [serverInfo],
  );
  const extensions = useUnaryOnce(() => api.extended.capabilities(), reachable) ?? NO_EXTENSIONS;

  useEffect(() => {
    setMenuOpen(false);
  }, [route]);

  const started = serviceStatusType === ServiceStatus_Type.STARTED;
  const hasGroups = started && groups.data.loaded && groups.data.groups.length > 0;
  const known = serviceStatus.phase !== "connecting" || serviceStatus.data.status !== null;
  const hasProviders = started && extensions.versions.outbound_provider !== undefined;
  const hasDns =
    started &&
    (extensions.versions.dns_query_log !== undefined || extensions.versions.dns_cache !== undefined);

  const groupsKnown = groups.data.loaded || groups.phase === "error";
  useEffect(() => {
    if (!known) {
      return;
    }
    const invisible =
      (route.page === "groups" && (!started || (groupsKnown && !hasGroups))) ||
      (route.page === "connections" && !started) ||
      (route.page === "providers" && (!started || (extensions.ready && !hasProviders))) ||
      (route.page === "dns" && (!started || (extensions.ready && !hasDns))) ||
      (isStartedOnlyToolsSubpage(route.page) && !started) ||
      (route.page === "tools/usbip" && capabilities.ready && !capabilities.supports("usbip")) ||
      (route.page === "tools/tailscale/taildrop" &&
        capabilities.ready &&
        !capabilities.supports("taildrop")) ||
      ((route.page === "tools/openconnect" || route.page === "tools/openvpn") &&
        capabilities.ready &&
        !capabilities.supports("openVpnAndOpenConnect"));
    if (invisible) {
      navigate(isStartedOnlyToolsSubpage(route.page) ? "tools" : "overview");
    }
  }, [known, started, groupsKnown, hasGroups, route, capabilities, extensions, hasProviders, hasDns]);

  if (lostError !== null) {
    return (
      <ConnectionErrorView
        server={props.server}
        error={lostError}
        reconnecting={serviceStatus.phase === "connecting"}
        onRetry={props.onRetry}
        serversState={props.serversState}
        onServersChange={props.onServersChange}
      />
    );
  }

  if (serviceStatus.data.status === null) {
    return (
      <div className={styles.connectingView}>
        <Brand className={styles.connectingBrand} />
        <Spinner className={styles.connectingSpinner} />
      </div>
    );
  }

  if (route.page === "tools/tailscale/ssh") {
    return (
      <TailscaleSSHView
        key={`${route.tag}/${route.peerID}/${route.username}/${route.terminalType}`}
        tag={route.tag}
        peerID={route.peerID}
        username={route.username}
        terminalType={route.terminalType}
      />
    );
  }

  const navItem = (
    page: string,
    title: string,
    icon: IconName,
    active: boolean,
    accessory?: ReactNode,
  ) => (
    <button
      type="button"
      key={page}
      className={cx(styles.navItem, active && styles.active)}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        setMenuOpen(false);
        navigate(page);
      }}
    >
      <Icon name={icon} size={17} />
      <span className={styles.navLabel}>{title}</span>
      {accessory}
    </button>
  );

  const pageContext = {
    server: serverDisplayName(props.server),
    section: routeSection(route, t),
  };

  return (
    <CapabilitiesContext.Provider value={capabilities}>
      <ExtensionsContext.Provider value={extensions}>
        <PageHeaderContext.Provider value={pageContext}>
          <div className={styles.app}>
            <header className={styles.mobileTopbar}>
              <IconButton
                aria-label={t("Toggle navigation")}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Icon name={menuOpen ? "close" : "menu"} size={18} />
              </IconButton>
              <BrandMark size={26} />
              <div className={styles.mobileTopbarBrand}>sing-box</div>
            </header>
            {menuOpen && (
              <button
                type="button"
                className={styles.sidebarScrim}
                aria-label={t("Close")}
                onClick={() => setMenuOpen(false)}
              />
            )}
            <nav className={cx(styles.sidebar, menuOpen && styles.open)}>
              <div className={styles.sidebarBrand}>
                <BrandMark />
                <div className={styles.sidebarBrandText}>
                  <span className={styles.sidebarBrandName}>sing-box</span>
                  <span className={styles.sidebarBrandVersion}>{serverInfo?.version ?? " "}</span>
                </div>
              </div>
              <div className={styles.navGroup}>
                {navItem("overview", t("Overview"), "dashboard", route.page === "overview")}
                {hasGroups &&
                  navItem(
                    "groups",
                    t("Groups"),
                    "folder",
                    route.page === "groups",
                    <NavCount value={groups.data.groups.length} />,
                  )}
                {hasProviders &&
                  navItem(
                    "providers",
                    t("Providers"),
                    "provider",
                    route.page === "providers",
                    <ProvidersNavCount />,
                  )}
                {started &&
                  navItem(
                    "connections",
                    t("Connections"),
                    "swap_vert",
                    route.page === "connections",
                    <ConnectionsNavCount />,
                  )}
                {hasDns && navItem("dns", "DNS", "dns", route.page === "dns")}
              </div>
              <div className={styles.navGroup}>
                {navItem("logs", t("Logs"), "text_snippet", route.page === "logs")}
                {navItem(
                  "tools",
                  t("Tools"),
                  "terminal",
                  route.page.startsWith("tools"),
                  started && capabilities.supports("taildrop") ? <TaildropNavBadge /> : undefined,
                )}
                {navItem("settings", t("Settings"), "tune", route.page.startsWith("settings"))}
              </div>
              <ServerPicker
                serversState={props.serversState}
                onServersChange={props.onServersChange}
                connected={reachable}
                started={started}
              />
            </nav>
            <main className={styles.content}>
              {route.page === "overview" && <OverviewView />}
              {route.page === "groups" && <GroupsView />}
              {route.page === "providers" && <ProvidersView />}
              {route.page === "connections" && <ConnectionsView />}
              {route.page === "dns" && <DnsView />}
              {route.page === "logs" && <LogsView />}
              {route.page === "tools" && <ToolsView />}
              {route.page === "tools/network-quality" && <NetworkQualityView />}
              {route.page === "tools/stun" && <STUNTestView />}
              {route.page === "tools/tailscale" && <TailscaleEndpointView tag={route.tag} />}
              {route.page === "tools/tailscale/taildrop" && <TaildropView tag={route.tag} />}
              {route.page === "tools/usbip" && <UsbipView tag={route.tag} />}
              {route.page === "tools/openconnect" && <OpenConnectView tag={route.tag} />}
              {route.page === "tools/openvpn" && <OpenVPNView tag={route.tag} />}
              {route.page === "settings" && <SettingsView />}
              {route.page === "settings/preferences/terminal" && <TerminalConfigurationView />}
              {route.page === "settings/preferences/terminal/theme" && (
                <TerminalThemePickerView scheme={route.scheme} />
              )}
              {route.page === "settings/preferences/terminal/custom" && (
                <TerminalThemeEditorView scheme={route.scheme} />
              )}
              {route.page === "settings/servers" && (
                <ServersView serversState={props.serversState} onServersChange={props.onServersChange} />
              )}
            </main>
            {serviceStatus.phase !== "active" && (
              <div className={styles.reconnectPill} role="status">
                <Spinner />
                {t("Reconnecting...")}
              </div>
            )}
            {started && <DeprecatedWarningsGate />}
          </div>
        </PageHeaderContext.Provider>
      </ExtensionsContext.Provider>
    </CapabilitiesContext.Provider>
  );
}

function NavCount(props: { value: number }) {
  return <span className={styles.navCount}>{props.value}</span>;
}

function ConnectionsNavCount() {
  const api = useApi();
  const status = useStream(api.status);
  const current = status.data.current;
  if (!current) {
    return null;
  }
  return <NavCount value={current.connectionsIn} />;
}

function ProvidersNavCount() {
  const api = useApi();
  const providers = useStream(api.extended.providers);
  if (!providers.data.loaded) {
    return null;
  }
  const failing = providers.data.providers.some((provider) => provider.lastError !== "");
  return (
    <span className={cx(styles.navCount, failing && styles.navCountAlert)}>
      {providers.data.providers.length}
    </span>
  );
}

function ServerPicker(props: {
  serversState: ServersState;
  onServersChange: (state: ServersState) => void;
  connected: boolean;
  started: boolean;
}) {
  const { t } = useI18n();
  const { servers, activeId } = props.serversState;
  const active = servers.find((server) => server.id === activeId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  if (!active) {
    return null;
  }

  return (
    <div className={styles.serverPicker} ref={ref}>
      <button type="button" className={styles.serverPickerButton} aria-expanded={open} onClick={() => setOpen(!open)}>
        <StateDot tone={props.connected ? "good" : undefined} className={cx(styles.serverDot, props.connected && "live")} />
        <span className={styles.serverPickerText}>
          <span className={styles.serverName}>{serverDisplayName(active)}</span>
          {props.started ? <ServerUptime /> : <span className={styles.serverUptime}>{t("Service not started")}</span>}
        </span>
        <Icon name="unfold_more" size={14} />
      </button>
      {open && (
        <div className="menu open-up">
          {servers.map((server) => (
            <button
              type="button"
              key={server.id}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                if (server.id !== activeId) {
                  props.onServersChange({ ...props.serversState, activeId: server.id });
                }
              }}
            >
              <span className="menu-check">{server.id === activeId && <Icon name="check" size={13} />}</span>
              {serverDisplayName(server)}
            </button>
          ))}
          <div className="menu-divider" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              navigate("settings/servers");
            }}
          >
            <span className="menu-check">
              <Icon name="settings" size={13} />
            </span>
            {t("Manage servers...")}
          </button>
        </div>
      )}
    </div>
  );
}

function ServerUptime() {
  const api = useApi();
  const { t, language } = useI18n();
  const now = useNow();
  const startedAt = useUnaryOnce(() => api.getStartedAt());

  if (startedAt === null) {
    return <span className={styles.serverUptime}>{" "}</span>;
  }
  return (
    <span className={styles.serverUptime} title={`${t("Uptime")} — ${formatDateTime(startedAt, language)}`}>
      {t("Uptime")} {formatUptime(startedAt, now)}
    </span>
  );
}

function DeprecatedWarningsGate() {
  const api = useApi();
  const warnings = useUnaryOnce(() => api.getDeprecatedWarnings());
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  if (loadDisableDeprecatedWarnings()) {
    return null;
  }

  const current = warnings?.[index];
  if (!current || !visible) {
    return null;
  }

  return (
    <DeprecatedWarningDialog
      warning={current}
      onDismiss={() => {
        setVisible(false);
        setTimeout(() => {
          setIndex((value) => value + 1);
          setVisible(true);
        }, 300);
      }}
    />
  );
}

function DeprecatedWarningDialog(props: { warning: DeprecatedWarning; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog onClose={props.onDismiss}>
      <h3>{t("Deprecated Warning")}</h3>
      <p className="dialog-message">{props.warning.message}</p>
      <div className="row-actions dialog-actions">
        <Button onClick={props.onDismiss}>
          {t("Ok")}
        </Button>
        {isHttpUrl(props.warning.migrationLink) && (
          <Button
            variant="primary"
            href={props.warning.migrationLink}
            target="_blank"
            rel="noreferrer"
            onClick={props.onDismiss}
          >
            {t("Documentation")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
