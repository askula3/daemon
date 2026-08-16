import { ConfigurationError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

export function validateServiceUrl(rawUrl: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigurationError(`Invalid service URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError(`Service URL must use HTTP or HTTPS: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new ConfigurationError("Service URL must not contain embedded credentials");
  }
  if (url.protocol === "http:" && !allowInsecureHttp && !isLoopback(url.hostname)) {
    throw new ConfigurationError(
      `Insecure HTTP is only allowed for loopback services: ${rawUrl}. ` +
      "Use HTTPS or explicitly set ALLOW_INSECURE_HTTP=true in the trusted server environment.",
    );
  }
  return url;
}

export function resolveSameOriginUrl(baseUrl: URL, endpoint: string): URL {
  const resolved = new URL(endpoint, `${baseUrl.origin}/`);
  if (resolved.origin !== baseUrl.origin) {
    throw new ConfigurationError(`Refusing cross-origin service URL: ${resolved.origin}`);
  }
  return resolved;
}

export async function fetchWithLimits(
  url: URL | string,
  init: RequestInit = {},
  options: { timeoutMs?: number; maxBodyBytes?: number } = {},
): Promise<{ response: Response; body: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const controller = new AbortController();
  const abort = (): void => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("HTTP request timed out")), timeoutMs);

  try {
    let currentUrl = new URL(url);
    let currentInit = { ...init };
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(currentUrl, {
        ...currentInit,
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error("HTTP redirect omitted Location header");
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.origin !== currentUrl.origin) {
        throw new Error(`Refusing cross-origin HTTP redirect to ${nextUrl.origin}`);
      }
      if (redirects === 5) throw new Error("HTTP request exceeded 5 redirects");
      await response.body?.cancel();
      if (response.status === 303 ||
          ((response.status === 301 || response.status === 302) && currentInit.method?.toUpperCase() === "POST")) {
        currentInit = { ...currentInit, method: "GET", body: undefined };
      }
      currentUrl = nextUrl;
    }
    if (!response) throw new Error("HTTP request did not produce a response");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      await response.body?.cancel();
      throw new Error(`HTTP response exceeds ${maxBodyBytes} bytes`);
    }
    if (!response.body) return { response, body: "" };

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBodyBytes) {
        await reader.cancel();
        throw new Error(`HTTP response exceeds ${maxBodyBytes} bytes`);
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
    return { response, body };
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export function parseJsonBody<T>(body: string, service: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${service} returned invalid JSON`);
  }
}
