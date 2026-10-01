import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrySetup } from "./retry";
import type { PlayerAdapter, PlayerState } from "./types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function adapterNeeding(need: PlayerState["need"], init: () => Promise<void>) {
  let current = need;
  const adapter = {
    state: () => ({ need: current }) as PlayerState,
    init: vi.fn(init),
  } as unknown as PlayerAdapter;
  return { adapter, set: (n: PlayerState["need"]) => (current = n) };
}

describe("retrySetup", () => {
  it("asks again while the adapter still needs setup", async () => {
    const { adapter } = adapterNeeding("setup", async () => undefined);
    retrySetup(adapter, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(adapter.init).toHaveBeenCalledTimes(3);
  });

  it("stops asking once the key is there, even though the timer keeps running", async () => {
    const { adapter, set } = adapterNeeding("setup", async () => undefined);
    retrySetup(adapter, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    set("authorization");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(adapter.init).toHaveBeenCalledTimes(1);
  });

  it("does not start a second attempt while one is still running", async () => {
    let release: () => void = () => undefined;
    const { adapter } = adapterNeeding("setup", () => new Promise<void>((r) => (release = r)));
    retrySetup(adapter, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(adapter.init).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.init).toHaveBeenCalledTimes(2);
  });

  it("keeps going after an attempt that throws", async () => {
    const { adapter } = adapterNeeding("setup", async () => {
      throw new Error("still no key");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    retrySetup(adapter, { intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(3_000);
    process.off("unhandledRejection", unhandled);

    expect(adapter.init).toHaveBeenCalledTimes(3);
  });

  it("stops when told to", async () => {
    const { adapter } = adapterNeeding("setup", async () => undefined);
    const stop = retrySetup(adapter, { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(adapter.init).toHaveBeenCalledTimes(1);
  });
});
