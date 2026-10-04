"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBrowserSessionService = createBrowserSessionService;
const access_1 = require("./access");
const neko_browsers_1 = require("./neko-browsers");
const neko_client_1 = require("./neko-client");
const security_1 = require("./security");
function parseIceServers(raw) {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
const PROXY_TARGET_TTL_MS = 10_000;
function createBrowserSessionService(deps) {
    const { config, store, placement, preferences } = deps;
    const neko = deps.neko ?? (0, neko_client_1.createNekoClient)();
    const proxyTargetCache = new Map();
    function syncLocalActiveCounts() {
        for (const worker of placement.store.list()) {
            const count = store.countByWorker(worker.id);
            placement.store.touchStatus(worker.id, {
                lastSeenAt: worker.kind === "local" ? Date.now() : worker.lastSeenAt ?? Date.now(),
                activeSessions: count,
                publicIp: worker.kind === "local" ? config.publicIp : undefined,
            });
        }
    }
    async function ensureRunning(session) {
        const info = await placement.inspect(session.workerId, session.containerId);
        if (!info || !info.running) {
            proxyTargetCache.delete(session.id);
            throw Object.assign(new Error("session_unavailable"), { statusCode: 503 });
        }
    }
    function cacheProxyTarget(sessionId, proxy) {
        proxyTargetCache.set(sessionId, {
            proxy,
            expiresAt: Date.now() + PROXY_TARGET_TTL_MS,
        });
    }
    async function destroyRecord(session) {
        proxyTargetCache.delete(session.id);
        try {
            await placement.remove(session.workerId, session.containerId);
        }
        finally {
            store.delete(session.id);
            syncLocalActiveCounts();
        }
    }
    return {
        getMine(username) {
            return store.getByOwner(username);
        },
        getById(id) {
            return store.getById(id);
        },
        list() {
            return store.list();
        },
        assertAccess(user, sessionId) {
            const session = store.getById(sessionId);
            if (!session) {
                throw Object.assign(new Error("not_found"), { statusCode: 404 });
            }
            if (!(0, access_1.canAccessBrowserSession)(user, session)) {
                throw Object.assign(new Error("forbidden"), { statusCode: 403 });
            }
            return session;
        },
        async resolveProxyTarget(sessionId) {
            const session = store.getById(sessionId);
            if (!session) {
                proxyTargetCache.delete(sessionId);
                throw Object.assign(new Error("not_found"), { statusCode: 404 });
            }
            const cached = proxyTargetCache.get(sessionId);
            if (cached && cached.expiresAt > Date.now()) {
                store.touch(session.id);
                return { session, proxy: cached.proxy };
            }
            await ensureRunning(session);
            const proxy = placement.proxyTarget(session.workerId, session.containerId, session.containerName);
            cacheProxyTarget(sessionId, proxy);
            store.touch(session.id);
            return { session, proxy };
        },
        async launch(user, browser) {
            const normalized = (0, neko_browsers_1.normalizeBrowserId)(browser);
            if (!normalized) {
                throw Object.assign(new Error("invalid_browser"), { statusCode: 400 });
            }
            (0, neko_browsers_1.assertBrowserEnabled)(config.enabledBrowsers, normalized);
            const existing = store.getByOwner(user.username);
            if (existing) {
                try {
                    await ensureRunning(existing);
                    store.touch(existing.id);
                    return { session: existing, reconnect: true };
                }
                catch {
                    await destroyRecord(existing);
                }
            }
            syncLocalActiveCounts();
            const persistProfile = config.persistProfilesEnabled && preferences.get(user.subjectId).persistProfile;
            const worker = placement.pickForLaunch({
                persistProfile,
                subjectId: user.subjectId,
                browser: normalized,
            });
            const sessionId = (0, security_1.randomToken)();
            const nekoAdminPassword = (0, security_1.randomToken)();
            const nekoUserPassword = (0, security_1.randomToken)();
            const now = Date.now();
            try {
                const created = await placement.createBrowser(worker, {
                    sessionId,
                    owner: user.username,
                    subjectId: user.subjectId,
                    browser: normalized,
                    nekoAdminPassword,
                    nekoUserPassword,
                    persistProfile,
                });
                // Local containers are reached over the Docker network; wait for readiness here.
                // Remote workers already wait inside the agent before returning.
                if (worker.kind === "local") {
                    const host = created.ipAddress || created.containerName;
                    if (!host)
                        throw new Error("container_missing_host");
                    try {
                        await neko.waitUntilReady(`http://${host}:8080`);
                    }
                    catch (readyError) {
                        const logs = await placement.logs(worker.id, created.containerId).catch(() => "");
                        const detail = readyError instanceof Error ? readyError.message : String(readyError);
                        await placement.remove(worker.id, created.containerId).catch(() => undefined);
                        throw new Error(logs ? `${detail} | logs: ${logs}` : detail);
                    }
                }
                const record = {
                    id: sessionId,
                    ownerUsername: user.username,
                    browser: normalized,
                    containerId: created.containerId,
                    containerName: created.containerName,
                    nekoAdminPassword,
                    nekoUserPassword,
                    webrtcPort: created.webrtcPort,
                    workerId: created.workerId,
                    createdAt: now,
                    lastActivityAt: now,
                };
                store.insert(record);
                syncLocalActiveCounts();
                return { session: record, reconnect: false };
            }
            catch (error) {
                syncLocalActiveCounts();
                throw error;
            }
        },
        async destroyForUser(username) {
            const existing = store.getByOwner(username);
            if (!existing)
                return false;
            await destroyRecord(existing);
            return true;
        },
        async destroyById(sessionId) {
            const existing = store.getById(sessionId);
            if (!existing)
                return false;
            await destroyRecord(existing);
            return true;
        },
        async issueAccess(user, sessionId) {
            const session = this.assertAccess(user, sessionId);
            await ensureRunning(session);
            store.touch(session.id);
            return {
                session,
                wsPath: `/session/${session.id}/view/ws`,
                username: "rbi",
                password: session.nekoAdminPassword,
                iceServers: parseIceServers(config.iceServersFrontend),
                allowClipboard: config.allowClipboard,
                allowDownloads: config.allowDownloads,
            };
        },
        async listForAdmin(viewerCount) {
            const sessions = store.list();
            const views = [];
            for (const session of sessions) {
                let cpuPercent = null;
                let memoryBytes = null;
                try {
                    const stats = await placement.stats(session.workerId, session.containerId);
                    cpuPercent = stats.cpuPercent;
                    memoryBytes = stats.memoryBytes;
                }
                catch {
                    /* stats are best-effort */
                }
                views.push({
                    id: session.id,
                    ownerUsername: session.ownerUsername,
                    browser: session.browser,
                    workerId: session.workerId,
                    createdAt: session.createdAt,
                    lastActivityAt: session.lastActivityAt,
                    viewers: viewerCount(session.id),
                    cpuPercent,
                    memoryBytes,
                });
            }
            return views;
        },
    };
}
//# sourceMappingURL=browser-sessions.js.map