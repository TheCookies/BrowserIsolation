import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import { safeEqual } from "../security";
import { isWorkerOnline } from "../workers/scheduler";

type EnrollBody = {
  workerId?: string;
  baseUrl?: string;
  publicIp?: string;
};

function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

function sanitizeWorkerId(raw: string): string | null {
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id || id.length > 64) return null;
  if (!/^[a-z0-9._-]+$/.test(id)) return null;
  return id;
}

function defaultWorkerId(): string {
  return `worker-${randomBytes(4).toString("hex")}`;
}

export function registerWorkerEnrollRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, workerStore, audit, placement } = deps;

  app.post<{ Body: EnrollBody }>(
    "/api/workers/enroll",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            workerId: { type: "string", maxLength: 64 },
            baseUrl: { type: "string", minLength: 1, maxLength: 512 },
            publicIp: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const expected = config.workerEnrollToken;
      if (!expected) {
        return reply.code(503).send({ error: "enroll_disabled" });
      }
      const provided = bearerToken(request.headers.authorization);
      if (!provided || !safeEqual(provided, expected)) {
        return reply.code(401).send({ error: "invalid_enroll_token" });
      }

      const publicIp = (request.body.publicIp ?? "").trim();
      if (!publicIp) {
        return reply.code(400).send({ error: "public_ip_required" });
      }

      let baseUrl = (request.body.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!baseUrl) {
        baseUrl = `http://${publicIp}:8090`;
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        return reply.code(400).send({ error: "invalid_base_url" });
      }

      const requestedId = (request.body.workerId ?? "").trim();
      let id = requestedId ? sanitizeWorkerId(requestedId) : defaultWorkerId();
      if (!id) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      if (id === "local") {
        return reply.code(400).send({ error: "reserved_id" });
      }

      const existing = workerStore.get(id);
      if (existing?.kind === "local") {
        return reply.code(400).send({ error: "reserved_id" });
      }

      // Shared agent secret: same WORKER_ENROLL_TOKEN on orchestrator + every worker.
      const token = expected;
      const priorGrant = workerStore.getGrant(id);
      // Preserve live enabled state, else prior grant (survives delete), else auto-enable.
      const enabled = existing ? existing.enabled : priorGrant !== null ? priorGrant : true;

      const worker = workerStore.upsert({
        id,
        baseUrl,
        publicIp,
        token,
        enabled,
        kind: "remote",
        lastSeenAt: null,
        activeSessions: existing?.activeSessions ?? 0,
      });
      workerStore.setGrant(worker.id, worker.enabled);

      let probeError: string | null = null;
      if (worker.enabled) {
        // Agent may not be listening yet during install; probe is best-effort.
        const probed = await placement.probeWorker(worker.id);
        if (!probed.ok) probeError = probed.error;
      }

      const latest = workerStore.get(worker.id) ?? worker;

      audit.record({
        actorUsername: "system",
        action: "create_worker",
        detail: existing
          ? `worker re-enrolled (${id}, enabled=${latest.enabled})`
          : latest.enabled
            ? `worker enrolled and authorized (${id})`
            : `worker enrolled pending authorize (${id})`,
      });

      request.log.info(
        {
          workerId: latest.id,
          enabled: latest.enabled,
          online: isWorkerOnline(latest),
          reenroll: Boolean(existing),
          probeError,
        },
        "worker enrolled",
      );

      return {
        id: latest.id,
        token,
        baseUrl: latest.baseUrl,
        publicIp: latest.publicIp,
        enabled: latest.enabled,
        online: isWorkerOnline(latest),
        probeError,
      };
    },
  );
}
