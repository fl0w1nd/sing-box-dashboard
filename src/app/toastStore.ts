import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  message: string;
}

const TOAST_MS = 1800;

let current: Toast | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A short confirmation at the bottom of the screen, for actions whose
// result is otherwise invisible (copying, flushing a cache).
export function showToast(message: string) {
  current = { id: nextId++, message };
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, TOAST_MS);
  emit();
}

export function useToast(): Toast | null {
  return useSyncExternalStore(subscribe, () => current);
}
