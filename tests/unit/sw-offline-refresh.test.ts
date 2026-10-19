import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshOfflinePageDaily } from "@/components/app/service-worker";

/* Check 46 P5: the page asks for a fresh no-signal page at most once a day per phone. */
describe("refreshOfflinePageDaily", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts once a day, and again the next day", () => {
    const worker = { postMessage: vi.fn() };
    expect(refreshOfflinePageDaily(worker, "2026-10-18")).toBe(true);
    expect(refreshOfflinePageDaily(worker, "2026-10-18")).toBe(false);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "refresh-offline" });
    expect(refreshOfflinePageDaily(worker, "2026-10-19")).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
  });

  it("no worker yet: nothing; storage refused: still asks, never throws", () => {
    expect(refreshOfflinePageDaily(null, "2026-10-18")).toBe(false);
    const refuse = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse });
    const worker = { postMessage: vi.fn() };
    expect(refreshOfflinePageDaily(worker, "2026-10-18")).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });
});
