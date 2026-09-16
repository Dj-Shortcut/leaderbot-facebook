import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setState, registerEffect } = vi.hoisted(() => ({
  setState: vi.fn(),
  registerEffect: vi.fn(),
}));

vi.mock("react", async importOriginal => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: () => [{ kind: "loading" }, setState],
  useEffect: registerEffect,
}));

import CreditCheckout from "./CreditCheckout";

let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    location: { pathname: "/credits/checkout/return" },
    setTimeout,
    clearTimeout,
  });
  registerEffect.mockImplementation((effect: () => () => void) => {
    cleanup = effect();
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reply(status: string) {
  return new Response(JSON.stringify({ status }), {
    headers: { "content-type": "application/json" },
  });
}

describe("bounded checkout status verification", () => {
  it("stops automatic polling after 30 seconds without declaring a payment outcome", async () => {
    const fetchStatus = vi.fn(async () => reply("processing"));
    vi.stubGlobal("fetch", fetchStatus);
    CreditCheckout();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(setState).toHaveBeenLastCalledWith({
      kind: "returned",
      status: "unconfirmed",
    });
    const requestsAtDeadline = fetchStatus.mock.calls.length;
    expect(requestsAtDeadline).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(requestsAtDeadline);
    expect(setState.mock.calls.flat()).not.toContainEqual({
      kind: "returned",
      status: "failed",
    });
  });

  it("bounds a stalled status request and keeps the result unconfirmed", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: RequestInit) => {
        requestSignal = options.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      })
    );
    CreditCheckout();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestSignal?.aborted).toBe(true);
    expect(setState).toHaveBeenLastCalledWith({
      kind: "returned",
      status: "unconfirmed",
    });
  });

  it("retains a confirmed payment and cancels the timeout", async () => {
    const fetchStatus = vi.fn(async () => reply("paid"));
    vi.stubGlobal("fetch", fetchStatus);
    CreditCheckout();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(setState).toHaveBeenLastCalledWith({
      kind: "returned",
      status: "paid",
    });
  });

  it("aborts on navigation without reporting a payment result afterward", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply("processing"))
    );
    CreditCheckout();
    cleanup?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setState).not.toHaveBeenCalled();
  });
});
