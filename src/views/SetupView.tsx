import { useEffect, useRef, useState } from "react";

import { createServerId, normalizeServerUrl, type Server } from "../api/config";
import { DaemonApi } from "../api/daemon";
import { useDiagnosedConnectError } from "../app/connectError";
import { LanguageSelect, useI18n, type Translate } from "../app/i18n";
import { Icon } from "../components/Icon";
import {
  ReachabilityIndicator,
  useServerReachability,
} from "../components/ReachabilityIndicator";
import { Brand, Button, Field, SecretInput, Spinner } from "../components/ui";
import { guessApiBaseUrl } from "../lib/connectivity";
import { checkServerReachable } from "../lib/reachability";
import styles from "./SetupView.module.css";

const CONNECT_TIMEOUT_MS = 8000;
const AUTODETECT_TIMEOUT_MS = 8000;

async function testConnection(
  server: Server,
  language: string,
  signal: AbortSignal,
  t: Translate,
): Promise<void> {
  const api = new DaemonApi(server, language);
  for await (const _ of api.client.subscribeServiceStatus({}, { signal })) {
    void _;
    return;
  }
  throw new Error(t("Stream ended without a status message"));
}

export function SetupView(props: { onCreate: (server: Server) => void }) {
  const { t, language } = useI18n();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<{ message: string; url: string } | null>(null);
  const errorDetail = useDiagnosedConnectError(error?.message ?? null, error?.url ?? "");
  const reachability = useServerReachability(url, secret);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    const candidate = guessApiBaseUrl(location.href);
    if (candidate === null) {
      return;
    }
    const normalized = normalizeServerUrl(candidate);
    if (normalized === "") {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTODETECT_TIMEOUT_MS);
    void checkServerReachable(normalized, "", language, controller.signal)
      .then((reachable) => {
        if (reachable) {
          setUrl((current) => (current === "" ? normalized : current));
        }
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [language]);

  const normalizedUrl = normalizeServerUrl(url);
  const valid = normalizedUrl !== "";

  const submit = async () => {
    if (!valid || connecting) {
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setConnecting(true);
    setError(null);
    try {
      const server: Server = {
        id: createServerId(),
        name: name.trim(),
        url: normalizedUrl,
        secret,
      };
      await Promise.race([
        testConnection(server, language, controller.signal, t),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                t("Connection timed out after {seconds} seconds", {
                  seconds: CONNECT_TIMEOUT_MS / 1000,
                }),
              ),
            );
          }, CONNECT_TIMEOUT_MS);
        }),
      ]);
      props.onCreate(server);
    } catch (connectError) {
      setError({
        message: connectError instanceof Error ? connectError.message : String(connectError),
        url: normalizedUrl,
      });
    } finally {
      clearTimeout(timer);
      setConnecting(false);
    }
  };

  return (
    <div className="setup dot-grid">
      <div className="setup-panel">
        <Brand />
        <p className={styles.setupIntro}>
          {t("Connect to the API service of a sing-box core to monitor and control it.")}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label={t("Name")}>
            <input
              className="input"
              value={name}
              placeholder={t("Optional")}
              disabled={connecting}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t("URL")}>
            <input
              className="input"
              value={url}
              placeholder={t("Required")}
              disabled={connecting}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <Field label={t("Secret")}>
            <SecretInput
              value={secret}
              placeholder={t("Optional")}
              disabled={connecting}
              onChange={setSecret}
            />
          </Field>
          {error === null && <ReachabilityIndicator reachability={reachability} url={url} />}
          {errorDetail !== null && (
            <div className="banner error">
              <Icon name="warning_amber" />
              <div>{errorDetail}</div>
            </div>
          )}
          <Button
            variant="primary"
            className={styles.setupSubmit}
            type="submit"
            disabled={!valid || connecting || reachability.status !== "online"}
          >
            {connecting && <Spinner />}
            {connecting ? t("Connecting...") : t("Connect")}
          </Button>
        </form>
        <div className={styles.setupFooter}>
          <div className="settings-row">
            <span className="settings-row-label">{t("Language")}</span>
            <LanguageSelect />
          </div>
        </div>
      </div>
    </div>
  );
}
