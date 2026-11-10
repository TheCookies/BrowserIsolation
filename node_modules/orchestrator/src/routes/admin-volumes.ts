import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app";
import { parseProfileVolumeName, profileStorageKey } from "../auth/identity";
import type { ProfileVolumeInfo } from "../docker/container-runtime";
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

export type AdminProfileVolume = {
  volumeName: string;
  subjectKey: string | null;
  subjectId: string | null;
  username: string | null;
  browser: string | null;
  workerId: string;
  sizeBytes: number | null;
  persistProfileEnabled: boolean | null;
  createdAt: string | null;
  mountpoint: string | null;
};

export type UserProfileUsage = {
  subjectKey: string;
  subjectId: string | null;
  username: string | null;
  volumeCount: number;
  sizeBytes: number;
};

type OwnerRef = { subjectId: string; username: string | null };

/**
 * Map profileStorageKey → owner. Local users alone miss LDAP/SAML identities;
 * also learn from browser sessions, portal sessions, and preference rows.
 */
export function buildProfileOwnerIndex(deps: AppDeps): Map<string, OwnerRef> {
  const usersByKey = new Map<string, OwnerRef>();

  function remember(subjectId: string, username: string | null, preferUsername = false) {
    const id = subjectId.trim();
    if (!id) return;
    const key = profileStorageKey(id);
    const existing = usersByKey.get(key);
    if (!existing) {
      usersByKey.set(key, { subjectId: id, username });
      return;
    }
    if (preferUsername && username && !existing.username) {
      usersByKey.set(key, { subjectId: existing.subjectId || id, username });
    } else if (username && (!existing.username || preferUsername)) {
      usersByKey.set(key, {
        subjectId: existing.subjectId || id,
        username,
      });
    } else if (!existing.subjectId) {
      usersByKey.set(key, { subjectId: id, username: existing.username });
    }
  }

  for (const user of deps.localUsers.list()) {
    remember(user.subjectId, user.username, true);
  }
  for (const session of deps.browsers.list()) {
    if (session.ownerSubjectId) {
      remember(session.ownerSubjectId, session.ownerUsername, true);
    }
  }
  for (const session of deps.sessions.listActive()) {
    remember(session.subjectId, session.username, true);
  }
  for (const prefs of deps.preferences.list()) {
    remember(prefs.subjectId, null, false);
  }

  return usersByKey;
}

async function collectAdminProfileVolumes(deps: AppDeps): Promise<{
  volumes: AdminProfileVolume[];
  errors: Array<{ workerId: string; error: string }>;
}> {
  const { workerStore, preferences, runtime, config } = deps;
  const usersByKey = buildProfileOwnerIndex(deps);

  const volumes: AdminProfileVolume[] = [];
  const errors: Array<{ workerId: string; error: string }> = [];

  async function ingest(workerId: string, items: ProfileVolumeInfo[]) {
    for (const item of items) {
      const owner = item.subjectKey ? usersByKey.get(item.subjectKey) : undefined;
      const subjectId = owner?.subjectId ?? null;
      let persistProfileEnabled: boolean | null = null;
      if (subjectId) {
        persistProfileEnabled = preferences.get(subjectId).persistProfile;
      }
      volumes.push({
        volumeName: item.name,
        subjectKey: item.subjectKey,
        subjectId,
        username: owner?.username ?? null,
        browser: item.browser,
        workerId,
        sizeBytes: item.sizeBytes,
        persistProfileEnabled,
        createdAt: item.createdAt,
        mountpoint: item.mountpoint,
      });
    }
  }

  const workers = workerStore.list().filter((worker) => worker.enabled);
  await Promise.all(
    workers.map(async (worker) => {
      try {
        if (worker.kind === "local") {
          if (!config.localWorkerEnabled) return;
          await ingest(worker.id, await runtime.listProfileVolumes());
          return;
        }
        if (!isWorkerOnline(worker)) {
          errors.push({ workerId: worker.id, error: "offline" });
          return;
        }
        const remote = createRemoteWorkerClient({
          baseUrl: worker.baseUrl,
          token: config.workerEnrollToken || worker.token,
        });
        const payload = await remote.volumes();
        await ingest(worker.id, payload.volumes ?? []);
      } catch (error) {
        errors.push({
          workerId: worker.id,
          error: error instanceof Error ? error.message : "list_failed",
        });
      }
    }),
  );

  volumes.sort((a, b) => {
    const userCmp = (a.username ?? a.subjectKey ?? "").localeCompare(
      b.username ?? b.subjectKey ?? "",
    );
    if (userCmp !== 0) return userCmp;
    const browserCmp = (a.browser ?? "").localeCompare(b.browser ?? "");
    if (browserCmp !== 0) return browserCmp;
    return a.workerId.localeCompare(b.workerId);
  });

  return { volumes, errors };
}

export function summarizeUsageByUser(volumes: AdminProfileVolume[]): UserProfileUsage[] {
  const byKey = new Map<string, UserProfileUsage>();
  for (const volume of volumes) {
    const key = volume.subjectKey ?? `unknown:${volume.volumeName}`;
    const current = byKey.get(key) ?? {
      subjectKey: volume.subjectKey ?? key,
      subjectId: volume.subjectId,
      username: volume.username,
      volumeCount: 0,
      sizeBytes: 0,
    };
    current.volumeCount += 1;
    if (typeof volume.sizeBytes === "number") current.sizeBytes += volume.sizeBytes;
    if (!current.username && volume.username) current.username = volume.username;
    if (!current.subjectId && volume.subjectId) current.subjectId = volume.subjectId;
    byKey.set(key, current);
  }
  return [...byKey.values()].sort((a, b) =>
    (a.username ?? a.subjectKey).localeCompare(b.username ?? b.subjectKey),
  );
}

export function registerAdminVolumeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { workerStore, runtime, config, audit } = deps;

  app.get("/api/admin/profile-volumes", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { volumes, errors } = await collectAdminProfileVolumes(deps);
    const knownSizes = volumes
      .map((volume) => volume.sizeBytes)
      .filter((value): value is number => typeof value === "number");
    return {
      volumes,
      totalBytes: knownSizes.reduce((sum, value) => sum + value, 0),
      errors,
      byUser: summarizeUsageByUser(volumes),
    };
  });

  app.delete<{
    Body: { workerId: string; volumeName: string };
  }>(
    "/api/admin/profile-volumes",
    {
      schema: {
        body: {
          type: "object",
          required: ["workerId", "volumeName"],
          additionalProperties: false,
          properties: {
            workerId: { type: "string", minLength: 1 },
            volumeName: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const workerId = request.body.workerId.trim();
      const volumeName = request.body.volumeName.trim();
      const parsed = parseProfileVolumeName(volumeName);
      if (!parsed) {
        return reply.code(400).send({ error: "invalid_volume" });
      }

      const worker = workerStore.get(workerId);
      if (!worker || !worker.enabled) {
        return reply.code(404).send({ error: "worker_not_found" });
      }

      try {
        if (worker.kind === "local") {
          if (!config.localWorkerEnabled) {
            return reply.code(400).send({ error: "local_worker_disabled" });
          }
          await runtime.removeProfileVolume(volumeName);
        } else {
          if (!isWorkerOnline(worker)) {
            return reply.code(502).send({ error: "worker_offline" });
          }
          const remote = createRemoteWorkerClient({
            baseUrl: worker.baseUrl,
            token: config.workerEnrollToken || worker.token,
          });
          await remote.removeVolume(volumeName);
        }
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 502;
        const message = error instanceof Error ? error.message : "delete_failed";
        request.log.warn({ err: error, workerId, volumeName }, "profile volume delete failed");
        return reply.code(statusCode >= 400 && statusCode < 600 ? statusCode : 502).send({
          error: message,
        });
      }

      // Best-effort sticky placement cleanup (local + LDAP/SAML owners).
      const owner = buildProfileOwnerIndex(deps).get(parsed.subjectKey);
      let username: string | null = owner?.username ?? null;
      if (owner?.subjectId) {
        deps.workerStore.clearProfilePlacement(owner.subjectId, parsed.browser);
      } else {
        for (const user of deps.localUsers.list()) {
          if (profileStorageKey(user.subjectId) !== parsed.subjectKey) continue;
          username = user.username;
          deps.workerStore.clearProfilePlacement(user.subjectId, parsed.browser);
          break;
        }
      }

      audit.record({
        actorUsername: request.authUser!.username,
        action: "delete_volume",
        ownerUsername: username ?? "",
        detail: `deleted ${volumeName} on worker ${workerId}` +
          (parsed.browser ? ` (${parsed.browser})` : ""),
      });

      return { ok: true };
    },
  );
}
