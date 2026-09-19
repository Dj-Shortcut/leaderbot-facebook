/**
 * Reads a response body into memory, checking the running byte count after
 * every chunk. When `assertWithinLimit` throws, the stream is cancelled so the
 * remaining bytes are never downloaded.
 */
export async function readResponseBodyWithinLimit(
  response: Response,
  assertWithinLimit: (byteLength: number) => void
): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertWithinLimit(buffer.length);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    try {
      assertWithinLimit(totalBytes);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    chunks.push(value);
  }

  return Buffer.concat(
    chunks.map(chunk =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )
  );
}
