export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchPolicy = {
  fetch?: FetchLike | undefined;
  retries?: number;
  timeoutMs?: number;
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function fetchWithPolicy(
  input: string | URL | Request,
  init: RequestInit = {},
  policy: FetchPolicy = {},
): Promise<Response> {
  const fetcher = policy.fetch ?? fetch;
  const retries = Math.max(0, Math.min(policy.retries ?? 1, 2));
  const timeoutMs = policy.timeoutMs ?? 30_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("HTTP request failed");
}
