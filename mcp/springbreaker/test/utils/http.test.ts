import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithLimits,
  resolveSameOriginUrl,
  validateServiceUrl,
} from "../../src/utils/http.js";

describe("bounded HTTP client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("requires HTTPS except for loopback services", () => {
    expect(() => validateServiceUrl("http://example.test", false)).toThrow("Insecure HTTP");
    expect(validateServiceUrl("http://127.0.0.1:8070", false).origin).toBe("http://127.0.0.1:8070");
    expect(validateServiceUrl("https://example.test", false).origin).toBe("https://example.test");
  });

  it("rejects embedded credentials and cross-origin endpoints", () => {
    expect(() => validateServiceUrl("https://user:secret@example.test", false)).toThrow(
      "embedded credentials",
    );
    expect(() => resolveSameOriginUrl(new URL("https://iq.example.test"), "https://evil.test/data"))
      .toThrow("cross-origin");
  });

  it("enforces declared response size limits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("too large", {
      headers: { "content-length": "1000" },
    })));
    await expect(fetchWithLimits("https://example.test", {}, { maxBodyBytes: 10 }))
      .rejects.toThrow("exceeds 10 bytes");
  });

  it("enforces streamed response size limits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("0123456789ABCDEF")));
    await expect(fetchWithLimits("https://example.test", {}, { maxBodyBytes: 8 }))
      .rejects.toThrow("exceeds 8 bytes");
  });

  it("follows same-origin redirects but refuses credential exfiltration", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "/raw-report" },
      }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithLimits("https://iq.example.test/old-report");
    expect(result.body).toBe("ok");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://iq.example.test/raw-report");

    fetchMock.mockReset().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://evil.test/steal" },
    }));
    await expect(fetchWithLimits("https://iq.example.test/report"))
      .rejects.toThrow("cross-origin HTTP redirect");
  });

  it("aborts requests at the configured deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: URL | string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        }, { once: true });
      }),
    ));
    const pending = fetchWithLimits("https://example.test", {}, { timeoutMs: 25 });
    const assertion = expect(pending).rejects.toThrow("HTTP request timed out");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});
