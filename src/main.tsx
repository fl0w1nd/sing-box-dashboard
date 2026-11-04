import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/globals.css";
import "./styles/shared.css";
import "./styles/ledger.css";

// iOS Safari ignores user-scalable=no and touch-action for pinch-zoom;
// cancelling WebKit's non-standard gesture events is the only way to disable it.
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
