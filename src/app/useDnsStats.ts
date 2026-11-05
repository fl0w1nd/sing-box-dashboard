import { useCallback, useEffect, useState } from "react";

import type { DNSQueryLogStats } from "../gen/daemon/extended_service_pb";
import { useApi } from "./context";
import { showError } from "./errorStore";

export interface DnsStatsRequest {
  // Milliseconds before now.
  span: number;
  // Seconds.
  bucket: number;
  top: number;
  // Errors are shown unless quiet.
  quiet?: boolean;
}

// useDnsStats loads the stats of the DNS query log for the last span when
// the request changes and when reload is called, never on its own: each
// load makes the core read the log of the whole span. `loading` is true
// while a load is in progress; `updated` is when the stats shown were
// loaded, in Unix milliseconds.
export function useDnsStats(request: DnsStatsRequest): {
  stats: DNSQueryLogStats | null;
  loading: boolean;
  updated: number | null;
  reload: () => void;
} {
  const api = useApi();
  const { span, bucket, top, quiet } = request;
  const [generation, setGeneration] = useState(0);
  const token = `${span}/${bucket}/${top}/${generation}`;
  const [stats, setStats] = useState<DNSQueryLogStats | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [loadedToken, setLoadedToken] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const now = Date.now();
    api.extended.dnsLogStats({ since: now - span }, bucket, top, controller.signal).then(
      (result) => {
        setStats(result);
        setUpdated(now);
        setLoadedToken(token);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadedToken(token);
          if (!quiet) {
            showError(error);
          }
        }
      },
    );
    return () => controller.abort();
  }, [api, token, span, bucket, top, quiet]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { stats, loading: loadedToken !== token, updated, reload };
}
