/**
 * Minimal Neko v3 HTTP client used by the orchestrator to obtain session tokens
 * so portal users never type or see Neko passwords.
 */
export type NekoLoginResult = {
  token: string;
};

export type NekoClient = {
  login(baseUrl: string, username: string, password: string): Promise<NekoLoginResult>;
  waitUntilReady(baseUrl: string, timeoutMs?: number): Promise<void>;
};

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function tokenFromSetCookie(headers: Headers): string | null {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  for (const cookie of cookies) {
    const match = /^NEKO_SESSION=([^;]+)/i.exec(cookie);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

export function createNekoClient(): NekoClient {
  return {
    async waitUntilReady(baseUrl, timeoutMs = 120_000) {
      const readyUrl = withTrailingSlash(baseUrl);
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          // Important: do not use new URL("/", baseUrl) — that strips the path prefix.
          const response = await fetch(readyUrl, { method: "GET" });
          if (
            response.ok ||
            response.status === 401 ||
            response.status === 403 ||
            response.status === 302
          ) {
            return;
          }
          lastError = new Error(`neko_http_${response.status}`);
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`neko_not_ready: ${String(lastError)}`);
    },

    async login(baseUrl, username, password) {
      const url = new URL("api/login", withTrailingSlash(baseUrl)).href;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { token?: string };
      if (!response.ok) {
        throw new Error(`neko_login_failed_${response.status}`);
      }
      const token = body.token || tokenFromSetCookie(response.headers);
      if (!token) {
        throw new Error("neko_login_missing_token");
      }
      return { token };
    },
  };
}
