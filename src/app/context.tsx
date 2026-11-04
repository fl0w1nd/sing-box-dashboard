import { createContext, useContext, useEffect, useState } from "react";

import type { DaemonApi } from "../api/daemon";
import { useLatestRef } from "./useLatest";

export const ApiContext = createContext<DaemonApi | null>(null);

export function useApi(): DaemonApi {
  const api = useContext(ApiContext);
  if (!api) {
    throw new Error("missing api context");
  }
  return api;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type NavigationGuard = (proceed: () => void) => void;

let navigationGuard: NavigationGuard | null = null;

export function navigate(path: string) {
  const go = () => {
    location.hash = `#/${path}`;
  };
  if (navigationGuard) {
    navigationGuard(go);
  } else {
    go();
  }
}

export function useNavigationGuard(active: boolean, onBlock: NavigationGuard) {
  const handler = useLatestRef(onBlock);
  useEffect(() => {
    if (!active) {
      return;
    }
    const guard = (proceed: () => void) => handler.current(proceed);
    navigationGuard = guard;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      if (navigationGuard === guard) {
        navigationGuard = null;
      }
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active, handler]);
}

const MOBILE_QUERY = "(max-width: 720px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

// The dashboard ships a single light theme for now; this keeps the browser
// chrome (theme-color, iOS status bar tint) in step with it.
export function applyTheme() {
  document.documentElement.dataset.theme = "light";
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  if (surface) {
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", surface);
    });
  }
}
