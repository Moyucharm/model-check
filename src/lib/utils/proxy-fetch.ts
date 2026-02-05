// Proxy-enabled fetch utility
// Supports HTTP/HTTPS proxy (via undici) and SOCKS5 proxy (via socks-proxy-agent)

import { ProxyAgent, fetch as undiciFetch, type RequestInit } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import https from "https";
import http from "http";

// Cache proxy agents to avoid creating new ones for each request
const httpProxyAgentCache = new Map<string, ProxyAgent>();
const socksProxyAgentCache = new Map<string, SocksProxyAgent>();

/**
 * Check if a proxy URL is SOCKS5
 */
function isSocksProxy(proxyUrl: string): boolean {
  const lower = proxyUrl.toLowerCase();
  return lower.startsWith("socks5://") || lower.startsWith("socks4://") || lower.startsWith("socks://");
}

/**
 * Get or create a HTTP ProxyAgent for the given proxy URL
 */
function getHttpProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = httpProxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    httpProxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Get or create a SOCKS ProxyAgent for the given proxy URL
 */
function getSocksProxyAgent(proxyUrl: string): SocksProxyAgent {
  let agent = socksProxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new SocksProxyAgent(proxyUrl);
    socksProxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

/**
 * Fetch using SOCKS proxy with native Node.js http/https
 * Returns a streaming response for real-time data delivery
 */
async function socksFetch(
  url: string | URL,
  options: RequestInit | undefined,
  socksAgent: SocksProxyAgent
): Promise<Response> {
  const urlObj = typeof url === "string" ? new URL(url) : url;
  const isHttps = urlObj.protocol === "https:";
  const httpModule = isHttps ? https : http;

  // Check if already aborted
  const signal = options?.signal as AbortSignal | undefined;
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  return new Promise((resolve, reject) => {
    const reqOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: (options?.method as string) || "GET",
      headers: options?.headers as http.OutgoingHttpHeaders,
      agent: socksAgent,
    };

    const req = httpModule.request(reqOptions, (res) => {
      // Convert Node.js headers to Headers object
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value) {
          if (Array.isArray(value)) {
            value.forEach((v) => headers.append(key, v));
          } else {
            headers.set(key, value);
          }
        }
      }

      // Create a ReadableStream from the Node.js response for streaming support
      const stream = new ReadableStream({
        start(controller) {
          res.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          res.on("end", () => {
            cleanup();
            controller.close();
          });
          res.on("error", (err) => {
            cleanup();
            controller.error(err);
          });
        },
        cancel() {
          res.destroy();
        },
      });

      // Resolve immediately with streaming response
      resolve(
        new Response(stream, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || "",
          headers,
        })
      );
    });

    // Handle abort signal
    const onAbort = () => {
      cleanup();
      req.destroy();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // Handle request body
    if (options?.body) {
      if (typeof options.body === "string") {
        req.write(options.body);
      } else if (Buffer.isBuffer(options.body)) {
        req.write(options.body);
      }
    }

    req.end();
  });
}

/**
 * Fetch with optional proxy support
 * @param url - The URL to fetch
 * @param options - Fetch options (same as native fetch)
 * @param proxy - Optional proxy URL (e.g., "http://127.0.0.1:7890" or "socks5://127.0.0.1:1080")
 * @returns Response object
 */
export async function proxyFetch(
  url: string | URL,
  options?: RequestInit,
  proxy?: string | null
): Promise<Response> {
  if (proxy) {
    if (isSocksProxy(proxy)) {
      // Use SOCKS proxy
      const agent = getSocksProxyAgent(proxy);
      return socksFetch(url, options, agent);
    } else {
      // Use HTTP/HTTPS proxy via undici
      const agent = getHttpProxyAgent(proxy);
      const response = await undiciFetch(url, {
        ...options,
        dispatcher: agent,
      });
      // Convert undici Response to standard Response for compatibility
      return response as unknown as Response;
    }
  }

  // No proxy, use native fetch
  return fetch(url.toString(), options as globalThis.RequestInit);
}

/**
 * Clear proxy agent cache (useful for cleanup or testing)
 */
export function clearProxyAgentCache(): void {
  for (const agent of httpProxyAgentCache.values()) {
    agent.close();
  }
  httpProxyAgentCache.clear();

  // SOCKS agents don't have a close method, just clear the cache
  socksProxyAgentCache.clear();
}
