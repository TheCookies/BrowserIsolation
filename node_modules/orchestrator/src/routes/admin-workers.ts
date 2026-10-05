import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app";
import { collectHostMetrics, type HostMetrics } from "../host-metrics";
import { createRemoteWorkerClient } from "../workers/client";
import { isWorkerOnline } from "../workers/scheduler";

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.authUser || !request.portalSession) {
    void reply.code(401).send({ error: "unauthenticated" });
    return false;
  }
  if (request.authUser.role !== "admin") {
    void reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

export function registerAdminWorkerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { workerStore, config, audit } = deps;

  app.get("/api/admin/workers", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const workers = workerStore.list().map((worker) => ({
      id: worker.id,
      baseUrl: worker.baseUrl,
      publicIp: worker.kind === "local" ? config.publicIp : worker.publicIp,
      enabled: worker.enabled,
      kind: worker.kind,
      online: isWorkerOnline(worker),
      lastSeenAt: worker.lastSeenAt ? new Date(worker.lastSeenAt).toISOString() : null,
      activeSessions: worker.activeSessions,
    }));
    return { workers };
  });

  app.post<{
    Body: { id: string; baseUrl: string; publicIp: string; token: string; enabled?: boolean };
  }>(
    "/api/admin/workers",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "baseUrl", "publicIp", "token"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            baseUrl: { type: "string", minLength: 1 },
            publicIp: { type: "string", minLength: 1 },
            token: { type: "string", minLength: 1 },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const id = request.body.id.trim();
      if (id === "local") {
        return reply.code(400).send({ error: "reserved_id" });
      }
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const baseUrl = request.body.baseUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(baseUrl)) {
        return reply.code(400).send({ error: "invalid_base_url" });
      }
      const worker = workerStore.upsert({
        id,
        baseUrl,
        publicIp: request.body.publicIp.trim(),
        // Prefer shared enroll secret when configured so manual adds can't desync auth.
        token: config.workerEnrollToken || request.body.token,
        enabled: request.body.enabled !== false,
        kind: "remote",
        lastSeenAt: null,
        activeSessions: 0,
      });
      audit.record({
        actorUsername: request.authUser!.username,
        action: "create_worker",
        detail: `registered worker ${worker.id} (${worker.baseUrl}, ip ${worker.publicIp})`,
      });
      return {
        ok: true,
        worker: {
          id: worker.id,
          baseUrl: worker.baseUrl,
          publicIp: worker.publicIp,
          enabled: worker.enabled,
          kind: worker.kind,
          online: isWorkerOnline(worker),
          lastSeenAt: worker.lastSeenAt ? new Date(worker.lastSeenAt).toISOString() : null,
          activeSessions: worker.activeSessions,
        },
      };
    },
  );

  app.patch<{ Params: { workerId: string }; Body: { enabled: boolean } }>(
    "/api/admin/workers/:workerId",
    {
      schema: {
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const existing = workerStore.get(request.params.workerId);
      if (!existing) return reply.code(404).send({ error: "not_found" });

      // Tear down sessions while the worker is still considered online so remove can run.
      if (!request.body.enabled) {
        const stranded = deps.browsers.list().filter((session) => session.workerId === existing.id);
        for (const session of stranded) {
          await deps.browsers.destroyById(session.id).catch(() => undefined);
        }
      }

      const worker = workerStore.setEnabled(request.params.workerId, request.body.enabled);
      if (!worker) return reply.code(404).send({ error: "not_found" });

      audit.record({
        actorUsername: request.authUser!.username,
        action: worker.enabled ? "enable_worker" : "disable_worker",
        detail: `${worker.enabled ? "enabled" : "disabled"} worker ${worker.id}`,
      });
      return {
        ok: true,
        worker: {
          id: worker.id,
          baseUrl: worker.baseUrl,
          publicIp: worker.kind === "local" ? config.publicIp : worker.publicIp,
          enabled: worker.enabled,
          kind: worker.kind,
          online: isWorkerOnline(worker),
          lastSeenAt: worker.lastSeenAt ? new Date(worker.lastSeenAt).toISOString() : null,
          activeSessions: worker.activeSessions,
        },
      };
    },
  );

  app.delete<{ Params: { workerId: string } }>(
    "/api/admin/workers/:workerId",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      if (request.params.workerId === "local") {
        return reply.code(400).send({ error: "cannot_delete_local" });
      }
      const workerId = request.params.workerId;
      const existing = workerStore.get(workerId);
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const stranded = deps.browsers.list().filter((session) => session.workerId === workerId);
      for (const session of stranded) {
        await deps.browsers.destroyById(session.id).catch(() => undefined);
      }

      const ok = workerStore.delete(workerId);
      if (!ok) return reply.code(404).send({ error: "not_found" });
      audit.record({
        actorUsername: request.authUser!.username,
        action: "delete_worker",
        detail: `removed worker ${workerId}${existing ? ` (${existing.baseUrl})` : ""}`,
      });
      return { ok: true };
    },
  );

  app.get<{ Params: { workerId: string } }>(
    "/api/admin/workers/:workerId/status",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const worker = workerStore.get(request.params.workerId);
      if (!worker) return reply.code(404).send({ error: "not_found" });

      try {
        let host: HostMetrics;
        let activeSessions = worker.activeSessions;
        if (worker.kind === "local") {
          host = await collectHostMetrics();
          activeSessions = deps.browsers.list().filter((session) => session.workerId === "local")
            .length;
        } else {
          const remote = createRemoteWorkerClient({
            baseUrl: worker.baseUrl,
            token: config.workerEnrollToken || worker.token,
          });
          const payload = await remote.host();
          host = payload.host as HostMetrics;
          activeSessions = payload.activeSessions;
          workerStore.touchStatus(worker.id, {
            lastSeenAt: Date.now(),
            activeSessions,
            publicIp: payload.publicIp || worker.publicIp,
          });
        }

        return {
          worker: {
            id: worker.id,
            kind: worker.kind,
            publicIp: worker.kind === "local" ? config.publicIp : worker.publicIp,
            baseUrl: worker.baseUrl,
            enabled: worker.enabled,
            online: isWorkerOnline(workerStore.get(worker.id) ?? worker),
            activeSessions,
          },
          host,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "status_failed";
        request.log.warn({ err: error, workerId: worker.id }, "worker status failed");
        return reply.code(502).send({ error: "worker_unreachable", message });
      }
    },
  );
}
