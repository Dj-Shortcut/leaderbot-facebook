/**
 * Runs an abortable request with a deadline. When the deadline passes, the
 * request's signal is aborted with the timeout error and the returned promise
 * rejects with that same error. The timer never keeps the process alive.
 */
export async function runWithAbortTimeout<T>(
  timeoutMs: number,
  createTimeoutError: () => Error,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = createTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
