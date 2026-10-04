"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNekoClient = createNekoClient;
function withTrailingSlash(baseUrl) {
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
function tokenFromSetCookie(headers) {
    const getSetCookie = headers.getSetCookie;
    const cookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
    for (const cookie of cookies) {
        const match = /^NEKO_SESSION=([^;]+)/i.exec(cookie);
        if (match?.[1]) {
            try {
                return decodeURIComponent(match[1]);
            }
            catch {
                return match[1];
            }
        }
    }
    return null;
}
function createNekoClient() {
    return {
        async waitUntilReady(baseUrl, timeoutMs = 120_000) {
            const readyUrl = withTrailingSlash(baseUrl);
            const deadline = Date.now() + timeoutMs;
            let lastError;
            while (Date.now() < deadline) {
                try {
                    // Important: do not use new URL("/", baseUrl) — that strips the path prefix.
                    const response = await fetch(readyUrl, { method: "GET" });
                    if (response.ok ||
                        response.status === 401 ||
                        response.status === 403 ||
                        response.status === 302) {
                        return;
                    }
                    lastError = new Error(`neko_http_${response.status}`);
                }
                catch (error) {
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
            const body = (await response.json().catch(() => ({})));
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
//# sourceMappingURL=neko-client.js.map