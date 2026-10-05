import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../config";
import type { ContainerRuntime } from "../docker/container-runtime";
import { collectHostMetrics } from "../host-metrics";
import { createNekoClient } from "../neko-client";
import type { PortPool } from "../port-pool";
import { safeEqual } from "../security";
import { toCreateInput } from "../workers/client";
import type { WorkerCreateBrowserRequest } from "../workers/types";

export type WorkerAgentDeps = {
  config: Config;
  workerId: string;
  /** Accepted Bearer tokens (shared enroll secret and/or legacy per-worker token). */
  tokens: string[];
  runtime: ContainerRuntime;
  ports: PortPool;
};

function authorize(requestToken: string | undefined, accepted: string[]): boolean {
  if (!requestToken || accepted.length === 0) return false;
  const value = requestToken.startsWith("Bearer ") ? requestToken.slice(7) : requestToken;
  return accepted.some((expected) => expected.length > 0 && safeEqual(value, expected));
}

export async function buildWorkerAgent(deps: WorkerAgentDeps): Promise<FastifyInstance> {
  const { config, workerId, tokens, runtime, ports } = deps;
  const neko = createNekoClient();
  const app = Fastify({ logger: true });
  const portByContainer = new Map<string, number>();

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/health")) return;
    if (!authorize(request.headers.authorization, tokens)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/v1/health", async () => ({ ok: true, id: workerId }));

  app.get("/v1/status", async () => {
    const managed = await runtime.listManaged();
    const running = managed.filter((item) => item.running).length;
    return {
      id: workerId,
      publicIp: config.publicIp,
      webrtcPortStart: config.webrtcPortStart,
      webrtcPortEnd: config.webrtcPortEnd,
      activeSessions: running,
      ok: true,
    };
  });

  app.get("/v1/host", async () => {
    const host = await collectHostMetrics();
    const managed = await runtime.listManaged();
    return {
      id: workerId,
      publicIp: config.publicIp,
      activeSessions: managed.filter((item) => item.running).length,
      host,
    };
  });

  app.get("/v1/volumes", async () => {
    const volumes = await runtime.listProfileVolumes();
    return { id: workerId, volumes };
  });

  app.delete<{ Params: { volumeName: string } }>(
    "/v1/volumes/:volumeName",
    async (request, reply) => {
      try {
        await runtime.removeProfileVolume(request.params.volumeName);
        return { ok: true };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        const message = error instanceof Error ? error.message : "remove_failed";
        return reply.code(statusCode).send({ error: message });
      }
    },
  );

  app.get("/v1/browsers", async () => {
    const browsers = await runtime.listManaged();
    return { browsers };
  });

  app.post<{ Body: WorkerCreateBrowserRequest }>("/v1/browsers", async (request, reply) => {
    const body = request.body;
    if (!body?.sessionId || !body.browser || !body.settings) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    let webrtcPort = 0;
    let containerId = "";
    try {
      webrtcPort = ports.allocate();
      const created = await runtime.createBrowserContainer(toCreateInput(body, webrtcPort));
      containerId = created.id;
      portByContainer.set(created.id, webrtcPort);

      const readyUrl =
        created.proxyOrigin ||
        (created.ipAddress ? `http://${created.ipAddress}:8080` : null);
      if (!readyUrl) throw new Error("container_missing_host");
      await neko.waitUntilReady(readyUrl);

      return {
        containerId: created.id,
        containerName: created.name,
        webrtcPort,
        publicIp: config.publicIp,
        ipAddress: created.ipAddress,
        proxyOrigin: created.proxyOrigin,
      };
    } catch (error) {
      if (containerId) {
        await runtime.remove(containerId).catch(() => undefined);
        portByContainer.delete(containerId);
      }
      if (webrtcPort) ports.release(webrtcPort);
      const message = error instanceof Error ? error.message : "create_failed";
      request.log.error({ err: error }, "worker create failed");
      return reply.code(500).send({ error: message });
    }
  });

  app.get<{ Params: { containerId: string } }>(
    "/v1/browsers/:containerId",
    async (request, reply) => {
      const info = await runtime.inspect(request.params.containerId);
      if (!info) return reply.code(404).send({ error: "not_found" });
      return info;
    },
  );

  app.get<{ Params: { containerId: string } }>(
    "/v1/browsers/:containerId/stats",
    async (request) => runtime.stats(request.params.containerId),
  );

  app.get<{ Params: { containerId: string }; Querystring: { tail?: string } }>(
    "/v1/browsers/:containerId/logs",
    async (request) => {
      const tail = Number(request.query.tail ?? "80");
      const logs = await runtime.logs(
        request.params.containerId,
        Number.isFinite(tail) ? tail : 80,
      );
      return { logs };
    },
  );

  app.delete<{ Params: { containerId: string } }>(
    "/v1/browsers/:containerId",
    async (request, reply) => {
      const id = request.params.containerId;
      const info = await runtime.inspect(id);
      if (!info) return reply.code(404).send({ error: "not_found" });
      await runtime.remove(id);
      const port = portByContainer.get(id);
      if (port) {
        ports.release(port);
        portByContainer.delete(id);
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { images?: string[] } }>("/v1/images/pull", async (request, reply) => {
    const images = request.body?.images;
    if (!Array.isArray(images) || images.length === 0) {
      return reply.code(400).send({ error: "images_required" });
    }
    const results = await runtime.pullImages(images.map(String));
    return { results };
  });

  app.post<{ Body: { images?: string[] } }>("/v1/images/remove", async (request, reply) => {
    const images = request.body?.images;
    if (!Array.isArray(images) || images.length === 0) {
      return reply.code(400).send({ error: "images_required" });
    }
    const results = await runtime.removeImages(images.map(String));
    return { results };
  });

  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });
  proxy.on("error", (error, _req, res) => {
    app.log.error({ err: error }, "worker neko proxy error");
    if (res && "writeHead" in res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
    }
  });

  const proxyHandler = async (
    request: import("fastify").FastifyRequest<{ Params: { containerId: string } }>,
    reply: import("fastify").FastifyReply,
  ) => {
    const info = await runtime.inspect(request.params.containerId);
    const target =
      info?.proxyOrigin || (info?.ipAddress ? `http://${info.ipAddress}:8080` : null);
    if (!info?.running || !target) {
      return reply.code(503).send({ error: "session_unavailable" });
    }
    const prefix = `/v1/proxy/${request.params.containerId}`;
    let url = request.raw.url ?? "/";
    if (url === prefix) url = "/";
    else if (url.startsWith(`${prefix}/`)) url = url.slice(prefix.length) || "/";
    request.raw.url = url;
    reply.hijack();
    proxy.web(request.raw, reply.raw, { target });
  };

  app.all("/v1/proxy/:containerId", proxyHandler);
  app.all("/v1/proxy/:containerId/*", proxyHandler);

  app.addHook("onListen", async () => {
    const server = app.server as Server;
    const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = req.url ?? "/";
      const match = /^\/v1\/proxy\/([^/]+)(\/.*)?(?:\?.*)?$/.exec(url.split("?")[0] ?? "");
      if (!match) return;

      const containerId = decodeURIComponent(match[1]!);
      const auth = req.headers.authorization;
      if (!authorize(auth, tokens)) {
        socket.write("HTTP/1.1 401 unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      void runtime
        .inspect(containerId)
        .then((info) => {
          const target =
            info?.proxyOrigin || (info?.ipAddress ? `http://${info.ipAddress}:8080` : null);
          if (!info?.running || !target) {
            socket.write("HTTP/1.1 503 unavailable\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          const prefix = `/v1/proxy/${containerId}`;
          let next = req.url ?? "/";
          if (next === prefix || next.startsWith(`${prefix}?`)) {
            next = next.replace(prefix, "/") || "/";
          } else if (next.startsWith(`${prefix}/`)) {
            next = next.slice(prefix.length) || "/";
          }
          req.url = next;
          proxy.ws(req, socket, head, { target });
        })
        .catch(() => {
          socket.write("HTTP/1.1 502 bad_gateway\r\nConnection: close\r\n\r\n");
          socket.destroy();
        });
    };
    server.prependListener("upgrade", onUpgrade);
    app.addHook("onClose", async () => {
      server.off("upgrade", onUpgrade);
      proxy.close();
    });
  });

  return app;
}
