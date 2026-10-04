"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileBrowserSessions = reconcileBrowserSessions;
exports.reapBrowserSessions = reapBrowserSessions;
exports.startBrowserReaper = startBrowserReaper;
const labels_1 = require("./docker/labels");
async function destroySession(deps, session, reason, log) {
    log?.info({ sessionId: session.id, owner: session.ownerUsername, reason, workerId: session.workerId }, "destroying browser session");
    try {
        await deps.placement.remove(session.workerId, session.containerId);
    }
    catch (error) {
        log?.warn({ err: error, sessionId: session.id }, "container remove failed during destroy");
    }
    deps.store.delete(session.id);
}
/**
 * Align SQLite browser_sessions with managed containers across all workers.
 */
async function reconcileBrowserSessions(deps, log) {
    const summary = {
        adopted: 0,
        removedOrphanContainers: 0,
        removedStaleSessions: 0,
    };
    const managed = await deps.placement.listManagedAll();
    const bySessionId = new Map();
    for (const container of managed) {
        const sessionId = container.labels[labels_1.LABEL_SESSION];
        if (sessionId)
            bySessionId.set(sessionId, container);
    }
    for (const session of deps.store.list()) {
        const labeled = bySessionId.get(session.id);
        if (labeled?.running) {
            if (labeled.id !== session.containerId || labeled.name !== session.containerName) {
                deps.store.updateContainer(session.id, {
                    containerId: labeled.id,
                    containerName: labeled.name,
                });
                summary.adopted += 1;
                log?.info({ sessionId: session.id, containerId: labeled.id, workerId: labeled.workerId }, "adopted running managed container");
            }
            bySessionId.delete(session.id);
            continue;
        }
        if (labeled) {
            await deps.placement.remove(labeled.workerId, labeled.id).catch(() => undefined);
            bySessionId.delete(session.id);
        }
        else {
            await deps.placement.remove(session.workerId, session.containerId).catch(() => undefined);
        }
        deps.store.delete(session.id);
        summary.removedStaleSessions += 1;
        log?.info({ sessionId: session.id }, "removed stale browser session without running container");
    }
    for (const orphan of bySessionId.values()) {
        await deps.placement.remove(orphan.workerId, orphan.id).catch(() => undefined);
        summary.removedOrphanContainers += 1;
        log?.info({
            containerId: orphan.id,
            workerId: orphan.workerId,
            sessionId: orphan.labels[labels_1.LABEL_SESSION],
            owner: orphan.labels[labels_1.LABEL_OWNER],
            browser: orphan.labels[labels_1.LABEL_BROWSER],
        }, "removed orphan managed container");
    }
    return summary;
}
async function reapBrowserSessions(deps, now = Date.now(), log) {
    const summary = { destroyedIdle: 0, destroyedExpired: 0 };
    const idleMs = deps.config.idleTimeoutMinutes * 60_000;
    const maxMs = deps.config.maxSessionHours * 60 * 60_000;
    for (const session of deps.store.list()) {
        if (now - session.createdAt >= maxMs) {
            await destroySession(deps, session, "max_session_hours", log);
            summary.destroyedExpired += 1;
            continue;
        }
        const viewerCount = deps.viewers.count(session.id);
        if (viewerCount > 0) {
            deps.store.touch(session.id, now);
            continue;
        }
        if (now - session.lastActivityAt >= idleMs) {
            await destroySession(deps, session, "idle_timeout", log);
            summary.destroyedIdle += 1;
        }
    }
    return summary;
}
function startBrowserReaper(deps, log) {
    let stopped = false;
    let timer;
    let running = false;
    const runOnce = async () => {
        if (running) {
            return { destroyedIdle: 0, destroyedExpired: 0 };
        }
        running = true;
        try {
            const summary = await reapBrowserSessions(deps, Date.now(), log);
            if (summary.destroyedIdle || summary.destroyedExpired) {
                log.info(summary, "reaper pass complete");
            }
            return summary;
        }
        catch (error) {
            log.error({ err: error }, "reaper pass failed");
            return { destroyedIdle: 0, destroyedExpired: 0 };
        }
        finally {
            running = false;
        }
    };
    const schedule = () => {
        timer = setTimeout(() => {
            void runOnce().finally(() => {
                if (!stopped)
                    schedule();
            });
        }, deps.config.reaperIntervalSeconds * 1000);
        timer.unref?.();
    };
    schedule();
    log.info({
        intervalSeconds: deps.config.reaperIntervalSeconds,
        idleTimeoutMinutes: deps.config.idleTimeoutMinutes,
        maxSessionHours: deps.config.maxSessionHours,
    }, "browser session reaper started");
    return {
        stop() {
            stopped = true;
            if (timer)
                clearTimeout(timer);
        },
        runOnce,
    };
}
//# sourceMappingURL=lifecycle.js.map