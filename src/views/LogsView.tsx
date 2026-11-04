import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { LogEntry } from "../api/daemon";
import { pad2 } from "../api/format";
import { isTerminalCode, useStream } from "../api/stream";
import { useApi } from "../app/context";
import { useDesktopHost } from "../app/desktop";
import { showError } from "../app/errorStore";
import { useStreamOutage } from "../app/hooks";
import { useI18n } from "../app/i18n";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StreamErrorBanner } from "../components/StreamBanner";
import { EmptyState, IconButton, MenuItem, OthersMenu, SearchInput, Spinner, SubMenu, useCopy } from "../components/ui";
import { LogLevel } from "../gen/daemon/started_service_pb";
import { ansiColorCss, parseAnsi, parseCssColor, stripAnsi, type Rgb } from "../lib/ansi";
import { canShare, shareError, shareFile } from "../lib/sharing";
import styles from "./LogsView.module.css";

const MAX_VISIBLE_LOGS = 1000;

const LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: LogLevel.ERROR, label: "Error" },
  { value: LogLevel.WARN, label: "Warn" },
  { value: LogLevel.INFO, label: "Info" },
  { value: LogLevel.DEBUG, label: "Debug" },
  { value: LogLevel.TRACE, label: "Trace" },
];

function useLogBackground(): Rgb {
  const [background, setBackground] = useState<Rgb>(() => resolveBackground());
  useEffect(() => {
    const observer = new MutationObserver(() => setBackground(resolveBackground()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return background;
}

function resolveBackground(): Rgb {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--card");
  return parseCssColor(value) ?? [255, 255, 255];
}

function logFileName(): string {
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`;
  return `logs-${timestamp}.txt`;
}

function onShareError(error: unknown): void {
  const reportableError = shareError(error);
  if (reportableError !== null) {
    showError(reportableError);
  }
}

export function LogsView() {
  const api = useApi();
  const host = useDesktopHost();
  const { t } = useI18n();
  const logs = useStream(api.logs);
  const outage = useStreamOutage(logs, isTerminalCode(logs.errorCode));
  const [level, setLevel] = useState<LogLevel | null>(null);
  // "manual" comes from the header button; "scroll" from reading back up
  // the log, which lifts again on its own at the bottom.
  const [paused, setPausedReason] = useState<"manual" | "scroll" | null>(null);
  const [frozen, setFrozen] = useState<LogEntry[]>([]);
  const [search, setSearch] = useState("");
  const viewRef = useRef<HTMLDivElement>(null);
  const background = useLogBackground();
  const [, copy] = useCopy();

  const effectiveLevel = level ?? logs.data.defaultLevel ?? LogLevel.INFO;

  const pause = (reason: "manual" | "scroll") => {
    if (paused === null) {
      setFrozen(logs.data.entries);
    }
    setPausedReason(reason);
  };

  const togglePause = () => {
    if (paused !== null) {
      setPausedReason(null);
    } else {
      pause("manual");
    }
  };

  const onScroll = () => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const distance = view.scrollHeight - view.scrollTop - view.clientHeight;
    if (distance > 32 && paused === null) {
      pause("scroll");
    } else if (distance <= 4 && paused === "scroll") {
      setPausedReason(null);
    }
  };

  const sourceEntries = paused !== null ? frozen : logs.data.entries;
  const lastFrozenId = frozen.length > 0 ? frozen[frozen.length - 1].id : -1;
  const unseen = paused !== null ? logs.data.entries.filter((entry) => entry.id > lastFrozenId).length : 0;

  const filtered = useMemo(() => {
    let entries = sourceEntries.filter((entry) => entry.level <= effectiveLevel);
    const query = search.trim().toLowerCase();
    if (query !== "") {
      entries = entries.filter((entry) => stripAnsi(entry.message).toLowerCase().includes(query));
    }
    return entries;
  }, [sourceEntries, effectiveLevel, search]);

  const visible = useMemo(
    () =>
      filtered.length > MAX_VISIBLE_LOGS
        ? filtered.slice(filtered.length - MAX_VISIBLE_LOGS)
        : filtered,
    [filtered],
  );

  const logsText = () => filtered.map((entry) => stripAnsi(entry.message)).join("\n");
  const sharingAvailable = canShare(host);

  const saveLogs = () => {
    const url = URL.createObjectURL(new Blob([logsText()], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = logFileName();
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const shareLogs = () => {
    const text = logsText();
    void shareFile(host, logFileName(), text, "text/plain").catch(onShareError);
  };

  useLayoutEffect(() => {
    if (paused !== null) {
      return;
    }
    const view = viewRef.current;
    if (view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [visible, paused]);

  let body: ReactNode;
  if (sourceEntries.length > 0 && outage === null) {
    body = (
      <div className={styles.logWrap}>
        <div className={styles.logView} ref={viewRef} onScroll={onScroll}>
          {visible.map((entry) => (
            <LogLine
              key={entry.id}
              message={entry.message}
              highlight={search.trim()}
              background={background}
            />
          ))}
        </div>
        {paused !== null && (
          <button type="button" className={styles.jump} onClick={() => setPausedReason(null)}>
            <Icon name="arrow_downward" size={13} />
            {unseen > 0 ? t("Back to latest · {count} new", { count: unseen }) : t("Back to latest")}
          </button>
        )}
      </div>
    );
  } else if (outage !== null) {
    body = null;
  } else if (logs.phase === "connecting") {
    body = (
      <EmptyState>
        <Spinner />
      </EmptyState>
    );
  } else {
    body = <EmptyState icon="text_snippet">{t("Empty logs")}</EmptyState>;
  }

  return (
    <div className="page page-full">
      <PageHeader
        title={t("Logs")}
        actions={
          <>
            <IconButton
              active={paused !== null}
              title={paused !== null ? t("Resume scrolling") : t("Pause scrolling")}
              onClick={togglePause}
            >
              <Icon name={paused !== null ? "play_arrow" : "pause"} />
            </IconButton>
            <OthersMenu>
              <SubMenu label={t("Log Level")} icon="filter_list">
                <MenuItem checked={level === null} onSelect={() => setLevel(null)}>
                  {t("Default")}
                </MenuItem>
                {LEVEL_OPTIONS.map((option) => (
                  <MenuItem
                    key={option.value}
                    checked={level === option.value}
                    onSelect={() => setLevel(option.value)}
                  >
                    {option.label}
                  </MenuItem>
                ))}
              </SubMenu>
              <SubMenu label={t("Save")} icon="save">
                <MenuItem
                  icon="content_copy"
                  onSelect={() => copy(logsText())}
                >
                  {t("To Clipboard")}
                </MenuItem>
                <MenuItem icon="save" onSelect={saveLogs}>
                  {t("To File")}
                </MenuItem>
                {sharingAvailable && (
                  <MenuItem icon="share" onSelect={shareLogs}>
                    {t("Share")}
                  </MenuItem>
                )}
              </SubMenu>
              <div className="menu-divider" />
              <MenuItem
                danger
                icon="delete"
                onSelect={() => {
                  void api.clearLogs().catch(showError);
                }}
              >
                {t("Clear Logs")}
              </MenuItem>
            </OthersMenu>
          </>
        }
      />
      <div className="field">
        <SearchInput value={search} onChange={setSearch} />
      </div>
      <StreamErrorBanner error={outage} />
      {body}
    </div>
  );
}

const LogLine = memo(function LogLine(props: {
  message: string;
  highlight: string;
  background: Rgb;
}) {
  const segments = parseAnsi(props.message);
  const query = props.highlight.toLowerCase();

  const ranges: [number, number][] = [];
  if (query !== "") {
    const plain = segments.map((segment) => segment.text).join("");
    const lower = plain.toLowerCase();
    let index = lower.indexOf(query);
    while (index !== -1) {
      ranges.push([index, index + query.length]);
      index = lower.indexOf(query, index + query.length);
    }
  }

  const parts: ReactNode[] = [];
  let offset = 0;
  let key = 0;
  for (const segment of segments) {
    const start = offset;
    const end = offset + segment.text.length;
    offset = end;

    let style: CSSProperties | undefined;
    if (segment.style) {
      style = {};
      if (segment.style.color) {
        style.color = ansiColorCss(segment.style.color, props.background);
      }
      if (segment.style.bold) {
        style.fontWeight = 700;
      }
      if (segment.style.italic) {
        style.fontStyle = "italic";
      }
      if (segment.style.underline) {
        style.textDecoration = "underline";
      }
    }

    const overlapping = ranges.filter(([from, to]) => to > start && from < end);
    let content: ReactNode;
    if (overlapping.length === 0) {
      content = segment.text;
    } else {
      const pieces: ReactNode[] = [];
      let cursor = 0;
      for (const [from, to] of overlapping) {
        const localFrom = Math.max(0, from - start);
        const localTo = Math.min(segment.text.length, to - start);
        if (localFrom > cursor) {
          pieces.push(segment.text.slice(cursor, localFrom));
        }
        pieces.push(<mark key={key++}>{segment.text.slice(localFrom, localTo)}</mark>);
        cursor = localTo;
      }
      if (cursor < segment.text.length) {
        pieces.push(segment.text.slice(cursor));
      }
      content = pieces;
    }

    if (style) {
      parts.push(
        <span key={key++} style={style}>
          {content}
        </span>,
      );
    } else {
      parts.push(<span key={key++}>{content}</span>);
    }
  }

  return <span className={styles.logLine}>{parts}</span>;
});
