import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import { randomToken, safeEqual } from "../security";

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
  const { config, workerStore, audit } = deps;

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

      const token = randomToken();
      const enabled = existing ? existing.enabled : false;
      const worker = workerStore.upsert({
        id,
        baseUrl,
        publicIp,
        token,
        enabled,
        kind: "remote",
        lastSeenAt: existing?.lastSeenAt ?? null,
        activeSessions: existing?.activeSessions ?? 0,
      });

      audit.record({
        actorUsername: "system",
        action: "create_worker",
        detail: existing
          ? `worker re-enrolled (${id}, enabled=${enabled})`
          : `worker enrolled pending authorize (${id})`,
      });

      request.log.info(
        { workerId: worker.id, enabled: worker.enabled, reenroll: Boolean(existing) },
        "worker enrolled",
      );

      return {
        id: worker.id,
        token,
        baseUrl: worker.baseUrl,
        publicIp: worker.publicIp,
        enabled: worker.enabled,
      };
    },
  );
}
