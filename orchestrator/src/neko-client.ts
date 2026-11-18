import http from "node:http";

/**
 * Minimal Neko v3 HTTP client used by the orchestrator to obtain session tokens
 * so portal users never type or see Neko passwords.
 */

type DirectResponse = {
  status: number;
  body: string;
  setCookie: string[];
};

// node:http ignores HTTP_PROXY. Global fetch would send 127.0.0.1 through a
// proxy and the readiness check would fail as "TypeError: fetch failed".
function directHttp(
  url: string,
  init: { method: string; body?: string; timeoutMs: number; headers?: Record<string, string> },
): Promise<DirectResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: init.method, headers: init.headers, timeout: init.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = res.headers["set-cookie"];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            setCookie: Array.isArray(raw) ? raw : raw ? [raw] : [],
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      const cause = new Error("timeout");
      (cause as { code?: string }).code = "ETIMEDOUT";
      reject(Object.assign(new Error("fetch failed"), { cause }));
    });
    req.on("error", (cause) => {
      reject(Object.assign(new Error("fetch failed"), { cause }));
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}
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

function tokenFromSetCookie(cookies: string[]): string | null {
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

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code =
      "code" in cause && typeof cause.code === "string" ? cause.code : "";
    return code ? `${error.message} [${code}]` : `${error.message} (${cause.message})`;
  }
  return error.message;
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
          const response = await directHttp(readyUrl, { method: "GET", timeoutMs: 1_500 });
          if (
            (response.status >= 200 && response.status < 300) ||
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
      throw new Error(`neko_not_ready ${readyUrl}: ${describeFetchError(lastError)}`);
    },

    async login(baseUrl, username, password) {
      const url = new URL("api/login", withTrailingSlash(baseUrl)).href;
      const response = await directHttp(url, {
        method: "POST",
        timeoutMs: 10_000,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      let body: { token?: string } = {};
      try {
        body = JSON.parse(response.body || "{}") as { token?: string };
      } catch {
        body = {};
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`neko_login_failed_${response.status}`);
      }
      const token = body.token || tokenFromSetCookie(response.setCookie);
      if (!token) {
        throw new Error("neko_login_missing_token");
      }
      return { token };
    },
  };
}
