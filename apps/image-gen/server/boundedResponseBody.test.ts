import { describe, expect, it, vi } from "vitest";
import { readResponseBodyWithinLimit } from "./_core/boundedResponseBody";

function limit(maxBytes: number) {
  return vi.fn((byteLength: number) => {
    if (byteLength > maxBytes) {
      throw new Error(`too large (${byteLength} bytes)`);
    }
  });
}

function streamingResponse(chunks: Uint8Array[]) {
  const cancel = vi.fn();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
    cancel,
  });
  return { response: new Response(body), cancel };
}

describe("readResponseBodyWithinLimit", () => {
  it("checks a body-less response once against its full length", async () => {
    const assertWithinLimit = limit(10);
    const response = {
      body: null,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as unknown as Response;

    await expect(
      readResponseBodyWithinLimit(response, assertWithinLimit)
    ).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(assertWithinLimit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("rejects a body-less response over the limit", async () => {
    const response = {
      body: null,
      arrayBuffer: async () => new Uint8Array(11).buffer,
    } as unknown as Response;

    await expect(
      readResponseBodyWithinLimit(response, limit(10))
    ).rejects.toThrow("too large (11 bytes)");
  });

  it("concatenates streamed chunks and checks the running total", async () => {
    const assertWithinLimit = limit(10);
    const { response, cancel } = streamingResponse([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4, 5]),
    ]);

    await expect(
      readResponseBodyWithinLimit(response, assertWithinLimit)
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(assertWithinLimit.mock.calls).toEqual([[2], [5]]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels the stream as soon as the running total exceeds the limit", async () => {
    const { response, cancel } = streamingResponse([
      new Uint8Array(6),
      new Uint8Array(6),
      new Uint8Array(6),
    ]);

    await expect(
      readResponseBodyWithinLimit(response, limit(10))
    ).rejects.toThrow("too large (12 bytes)");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
