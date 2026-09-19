import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithAbortTimeout } from "./_core/abortTimeout";

describe("runWithAbortTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the request result and clears the deadline", async () => {
    vi.useFakeTimers();
    const createTimeoutError = vi.fn(() => new Error("timed out"));

    await expect(
      runWithAbortTimeout(1_000, createTimeoutError, async () => "done")
    ).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    expect(createTimeoutError).not.toHaveBeenCalled();
  });

  it("aborts the signal and rejects with the same timeout error", async () => {
    vi.useFakeTimers();
    const timeoutError = new Error("timed out");
    let signal: AbortSignal | undefined;

    const result = runWithAbortTimeout(
      1_000,
      () => timeoutError,
      requestSignal => {
        signal = requestSignal;
        return new Promise<string>(() => {});
      }
    );
    const assertion = expect(result).rejects.toBe(timeoutError);
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(timeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates a request failure without aborting", async () => {
    vi.useFakeTimers();
    const failure = new Error("request failed");
    let signal: AbortSignal | undefined;

    await expect(
      runWithAbortTimeout(
        1_000,
        () => new Error("timed out"),
        async requestSignal => {
          signal = requestSignal;
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
