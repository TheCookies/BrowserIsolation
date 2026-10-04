"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarizeUsageByUser = summarizeUsageByUser;
exports.registerAdminVolumeRoutes = registerAdminVolumeRoutes;
const identity_1 = require("../auth/identity");
const client_1 = require("../workers/client");
const scheduler_1 = require("../workers/scheduler");
function requireAdmin(request, reply) {
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
async function collectAdminProfileVolumes(deps) {
    const { workerStore, localUsers, preferences, runtime, config } = deps;
    const usersByKey = new Map();
    for (const user of localUsers.list()) {
        usersByKey.set((0, identity_1.profileStorageKey)(user.subjectId), {
            subjectId: user.subjectId,
            username: user.username,
        });
    }
    const volumes = [];
    const errors = [];
    async function ingest(workerId, items) {
        for (const item of items) {
            const owner = item.subjectKey ? usersByKey.get(item.subjectKey) : undefined;
            const subjectId = owner?.subjectId ?? null;
            let persistProfileEnabled = null;
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
    await Promise.all(workers.map(async (worker) => {
        try {
            if (worker.kind === "local") {
                if (!config.localWorkerEnabled)
                    return;
                await ingest(worker.id, await runtime.listProfileVolumes());
                return;
            }
            if (!(0, scheduler_1.isWorkerOnline)(worker)) {
                errors.push({ workerId: worker.id, error: "offline" });
                return;
            }
            const remote = (0, client_1.createRemoteWorkerClient)({
                baseUrl: worker.baseUrl,
                token: worker.token,
            });
            const payload = await remote.volumes();
            await ingest(worker.id, payload.volumes ?? []);
        }
        catch (error) {
            errors.push({
                workerId: worker.id,
                error: error instanceof Error ? error.message : "list_failed",
            });
        }
    }));
    volumes.sort((a, b) => {
        const userCmp = (a.username ?? a.subjectKey ?? "").localeCompare(b.username ?? b.subjectKey ?? "");
        if (userCmp !== 0)
            return userCmp;
        const browserCmp = (a.browser ?? "").localeCompare(b.browser ?? "");
        if (browserCmp !== 0)
            return browserCmp;
        return a.workerId.localeCompare(b.workerId);
    });
    return { volumes, errors };
}
function summarizeUsageByUser(volumes) {
    const byKey = new Map();
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
        if (typeof volume.sizeBytes === "number")
            current.sizeBytes += volume.sizeBytes;
        if (!current.username && volume.username)
            current.username = volume.username;
        if (!current.subjectId && volume.subjectId)
            current.subjectId = volume.subjectId;
        byKey.set(key, current);
    }
    return [...byKey.values()].sort((a, b) => (a.username ?? a.subjectKey).localeCompare(b.username ?? b.subjectKey));
}
function registerAdminVolumeRoutes(app, deps) {
    const { workerStore, runtime, config, audit } = deps;
    app.get("/api/admin/profile-volumes", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const { volumes, errors } = await collectAdminProfileVolumes(deps);
        const knownSizes = volumes
            .map((volume) => volume.sizeBytes)
            .filter((value) => typeof value === "number");
        return {
            volumes,
            totalBytes: knownSizes.reduce((sum, value) => sum + value, 0),
            errors,
            byUser: summarizeUsageByUser(volumes),
        };
    });
    app.delete("/api/admin/profile-volumes", {
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
    }, async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const workerId = request.body.workerId.trim();
        const volumeName = request.body.volumeName.trim();
        const parsed = (0, identity_1.parseProfileVolumeName)(volumeName);
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
            }
            else {
                if (!(0, scheduler_1.isWorkerOnline)(worker)) {
                    return reply.code(502).send({ error: "worker_offline" });
                }
                const remote = (0, client_1.createRemoteWorkerClient)({
                    baseUrl: worker.baseUrl,
                    token: worker.token,
                });
                await remote.removeVolume(volumeName);
            }
        }
        catch (error) {
            const statusCode = error.statusCode ?? 502;
            const message = error instanceof Error ? error.message : "delete_failed";
            request.log.warn({ err: error, workerId, volumeName }, "profile volume delete failed");
            return reply.code(statusCode >= 400 && statusCode < 600 ? statusCode : 502).send({
                error: message,
            });
        }
        // Best-effort sticky placement cleanup when we can map the volume to a user.
        let username = null;
        for (const user of deps.localUsers.list()) {
            if ((0, identity_1.profileStorageKey)(user.subjectId) !== parsed.subjectKey)
                continue;
            username = user.username;
            deps.workerStore.clearProfilePlacement(user.subjectId, parsed.browser);
            break;
        }
        audit.record({
            actorUsername: request.authUser.username,
            action: "delete_volume",
            ownerUsername: username ?? "",
            detail: `deleted ${volumeName} on worker ${workerId}` +
                (parsed.browser ? ` (${parsed.browser})` : ""),
        });
        return { ok: true };
    });
}
//# sourceMappingURL=admin-volumes.js.map