import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { canAccessBrowserSession } from "./access";
import type { AppDeps } from "./app";
import type { BrowserSessionRecord } from "./browser-session-store";

const VIEW_PREFIX = /^\/session\/([^/]+)\/view(\/.*)?$/;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function sessionIdFromUrl(url: string): string | null {
  const pathOnly = url.split("?")[0] ?? url;
  const match = VIEW_PREFIX.exec(pathOnly);
  return match?.[1] ?? null;
}

/** Strip /session/:id/view so Neko (running at /) receives /ws, /api/*, etc. */
function rewriteViewPath(url: string, sessionId: string): string {
  const prefix = `/session/${sessionId}/view`;
  const [pathPart, query = ""] = url.split("?");
  let path = pathPart ?? "/";
  if (path === prefix) {
    path = "/";
  } else if (path.startsWith(`${prefix}/`)) {
    path = path.slice(prefix.length) || "/";
  }
  return query ? `${path}?${query}` : path;
}

function authorizeProxy(
  deps: AppDeps,
  cookieHeader: string | undefined,
  sessionId: string,
): { ok: true; session: BrowserSessionRecord } | { ok: false; status: number; error: string } {
  const cookies = parseCookies(cookieHeader);
  const portalSessionId = cookies[deps.config.cookieName];
  if (!portalSessionId) {
    return { ok: false, status: 401, error: "unauthenticated" };
  }
  const portal = deps.sessions.get(portalSessionId);
  if (!portal) {
    return { ok: false, status: 401, error: "unauthenticated" };
  }
  const browserSession = deps.browsers.getById(sessionId);
  if (!browserSession) {
    return { ok: false, status: 404, error: "not_found" };
  }
  const user = {
    username: portal.username,
    role: portal.role,
    subjectId: portal.subjectId,
  };
  if (!canAccessBrowserSession(user, browserSession)) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, session: browserSession };
}

function writeSocketError(socket: Socket, status: number, message: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${message.length}\r\n\r\n${message}`,
    );
  }
  socket.destroy();
}

export async function registerSessionProxy(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: true,
  });

  proxy.on("error", (error, _req, res) => {
    app.log.error({ err: error }, "session proxy error");
    if (res && "writeHead" in res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
      return;
    }
    if (res && "destroy" in res && typeof res.destroy === "function") {
      res.destroy();
    }
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId;
    if (!sessionId) {
      return reply.code(404).send({ error: "not_found" });
    }

    if (!request.authUser || !request.portalSession) {
      return reply.code(401).send({ error: "unauthenticated" });
    }

    let targetOrigin: string;
    let proxyHeaders: Record<string, string> | undefined;
    try {
      deps.browsers.assertAccess(request.authUser, sessionId);
      const resolved = await deps.browsers.resolveProxyTarget(sessionId);
      targetOrigin = resolved.proxy.targetOrigin;
      proxyHeaders = resolved.proxy.headers;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const message = error instanceof Error ? error.message : "proxy_failed";
      if (statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send({ error: message });
      }
      request.log.error({ err: error }, "proxy resolve failed");
      return reply.code(502).send({ error: "bad_gateway" });
    }

    reply.hijack();
    request.raw.url = rewriteViewPath(request.raw.url ?? "/", sessionId);
    proxy.web(request.raw, reply.raw, { target: targetOrigin, headers: proxyHeaders });
  };

  app.all("/session/:sessionId/view", handler);
  app.all("/session/:sessionId/view/*", handler);

  const server = app.server as Server;
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? "/";
    const sessionId = sessionIdFromUrl(url);
    if (!sessionId) {
      return;
    }

    const auth = authorizeProxy(deps, req.headers.cookie, sessionId);
    if (!auth.ok) {
      writeSocketError(socket, auth.status, auth.error);
      return;
    }

    void deps.browsers
      .resolveProxyTarget(sessionId)
      .then((resolved) => {
        req.url = rewriteViewPath(req.url ?? "/", sessionId);
        const pathOnly = (req.url ?? "/").split("?")[0] ?? "/";
        app.log.info({ sessionId, path: pathOnly }, "proxying session websocket");
        const leave = deps.viewers.join(sessionId);
        socket.once("close", leave);
        socket.once("error", leave);
        proxy.ws(req, socket, head, {
          target: resolved.proxy.targetOrigin,
          headers: resolved.proxy.headers,
        });
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, "websocket proxy failed");
        writeSocketError(socket, 502, "bad_gateway");
      });
  };

  server.prependListener("upgrade", onUpgrade);
  app.addHook("onClose", async () => {
    server.off("upgrade", onUpgrade);
    proxy.close();
  });
}
