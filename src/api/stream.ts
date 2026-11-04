import { Code, ConnectError } from "@connectrpc/connect";
import { useSyncExternalStore } from "react";

export type StreamPhase = "connecting" | "active" | "error";

export interface StreamSnapshot<T> {
  phase: StreamPhase;
  error?: string;
  errorCode?: Code;
  data: T;
}

export interface StreamContext<T> {
  signal: AbortSignal;
  update(updater: (data: T) => T): void;
}

export function describeError(error: unknown): { message: string; code?: Code } {
  if (error instanceof ConnectError) {
    return { message: error.rawMessage, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

export function isTerminalCode(code: Code | undefined): boolean {
  return (
    code === Code.Unimplemented ||
    code === Code.NotFound ||
    code === Code.Unauthenticated ||
    code === Code.PermissionDenied
  );
}

export class StreamStore<T> {
  private listeners = new Set<() => void>();
  // Observers see updates but never open the stream themselves; see peek.
  private observers = new Set<() => void>();
  private running = false;
  private snapshot: StreamSnapshot<T>;
  private controller: AbortController | null = null;
  private skipBackoff = false;
  private wakeBackoff: (() => void) | null = null;
  private flushHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private createInitial: () => T,
    private runStream: (context: StreamContext<T>) => Promise<void>,
    private resetOnReconnect = false,
  ) {
    this.snapshot = { phase: "connecting", data: createInitial() };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.start();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  };

  getSnapshot = (): StreamSnapshot<T> => this.snapshot;

  observe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  };

  // The snapshot while some page keeps the stream open, otherwise null.
  peek = (): StreamSnapshot<T> | null => (this.running ? this.snapshot : null);

  private notifyObservers() {
    for (const observer of this.observers) {
      observer();
    }
  }

  retryNow = (): void => {
    this.skipBackoff = true;
    this.wakeBackoff?.();
  };

  reconnectNow = (): void => {
    if (this.listeners.size === 0) {
      return;
    }
    this.stop();
    this.start();
  };

  private setSnapshot(next: StreamSnapshot<T>) {
    this.snapshot = next;
    if (this.flushHandle === null) {
      this.flushHandle = setTimeout(() => {
        this.flushHandle = null;
        for (const listener of this.listeners) {
          listener();
        }
        this.notifyObservers();
      });
    }
  }

  private start() {
    const controller = new AbortController();
    this.controller = controller;
    this.skipBackoff = false;
    this.running = true;
    queueMicrotask(() => this.notifyObservers());
    void this.loop(controller.signal);
  }

  private stop() {
    this.controller?.abort();
    this.controller = null;
    this.running = false;
    queueMicrotask(() => this.notifyObservers());
    if (this.flushHandle !== null) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
  }

  private async loop(signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted) {
      const data = this.resetOnReconnect ? this.createInitial() : this.snapshot.data;
      if (this.snapshot.phase !== "error") {
        this.setSnapshot({ phase: "connecting", data });
      } else if (this.resetOnReconnect) {
        this.setSnapshot({ ...this.snapshot, data });
      }
      try {
        await this.runStream({
          signal,
          update: (updater) => {
            attempt = 0;
            this.setSnapshot({ phase: "active", data: updater(this.snapshot.data) });
          },
        });
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const described = describeError(error);
        this.setSnapshot({
          ...this.snapshot,
          phase: "error",
          error: described.message,
          errorCode: described.code,
        });
        if (isTerminalCode(described.code)) {
          return;
        }
      }
      attempt += 1;
      await this.backoff(Math.min(1000 * attempt, 5000), signal);
      if (this.skipBackoff) {
        this.skipBackoff = false;
        attempt = 0;
      }
    }
  }

  private backoff(durationMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || this.skipBackoff) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.wakeBackoff = null;
        resolve();
      };
      const timer = setTimeout(finish, durationMs);
      signal.addEventListener("abort", finish, { once: true });
      this.wakeBackoff = finish;
    });
  }
}

export function useStream<T>(store: StreamStore<T>): StreamSnapshot<T> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

// Browsers allow six HTTP/1.1 connections per host and every open stream
// holds one, so a request made after six streams waits until one closes.
// Side indicators (navigation counts, badges) therefore only show data from
// streams a page already has open, and never open one of their own.
export function usePeekStream<T>(store: StreamStore<T>): StreamSnapshot<T> | null {
  return useSyncExternalStore(store.observe, store.peek);
}
