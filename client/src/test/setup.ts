import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(String(key));
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value));
    },
  };
}

// Node 24 exposes experimental web-storage globals that are unavailable unless
// the process is given --localstorage-file. That can shadow jsdom's storage
// objects with undefined, so tests install deterministic in-memory instances.
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(window, "sessionStorage", {
  configurable: true,
  value: createMemoryStorage(),
});

afterEach(() => {
  cleanup();
});

// jsdom does not implement Element.scrollIntoView — stub it globally.
HTMLElement.prototype.scrollIntoView = vi.fn();

// jsdom does not implement window.matchMedia — stub it so components that
// check prefers-color-scheme or use media-query hooks don't crash in tests.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
