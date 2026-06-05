interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 300));
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = i === attempts - 1;
      if (isLast || !shouldRetry(error, i + 1)) {
        break;
      }
      const wait = baseDelayMs * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown retry error");
}
