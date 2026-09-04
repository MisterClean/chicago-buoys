import { describe, expect, it, vi } from "vitest";

import { fetchWithPolicy } from "../../src/sources/http.js";

describe("fetchWithPolicy", () => {
  it("caps retries at two even when a larger value is requested", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));

    const response = await fetchWithPolicy("https://example.test", {}, { fetch: fetcher, retries: 99 });

    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient status", async () => {
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 }));

    const response = await fetchWithPolicy("https://example.test", {}, { fetch: fetcher, retries: 2 });

    expect(response.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
