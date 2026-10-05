"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminRoutes = registerAdminRoutes;
const audit_store_1 = require("../audit-store");
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
function registerAdminRoutes(app, deps) {
    const { browsers, audit, viewers, settings, config } = deps;
    app.get("/api/admin/sessions", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const rows = await browsers.listForAdmin((sessionId) => viewers.count(sessionId));
        const sessions = rows.map((row) => ({
            id: row.id,
            owner: row.ownerUsername,
            browser: row.browser,
            workerId: row.workerId,
            createdAt: new Date(row.createdAt).toISOString(),
            lastActivityAt: new Date(row.lastActivityAt).toISOString(),
            viewers: row.viewers,
            cpuPercent: row.cpuPercent,
            memoryBytes: row.memoryBytes,
        }));
        return { sessions };
    });
    app.post("/api/admin/sessions/:sessionId/join", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const user = request.authUser;
        try {
            const access = await browsers.issueAccess(user, request.params.sessionId);
            audit.record({
                actorUsername: user.username,
                action: "join",
                sessionId: access.session.id,
                ownerUsername: access.session.ownerUsername,
                detail: access.session.ownerUsername === user.username
                    ? "joined own session"
                    : `joined session owned by ${access.session.ownerUsername}`,
            });
            return {
                session: {
                    id: access.session.id,
                    owner: access.session.ownerUsername,
                    browser: access.session.browser,
                    createdAt: new Date(access.session.createdAt).toISOString(),
                    lastActivityAt: new Date(access.session.lastActivityAt).toISOString(),
                    webrtcPort: access.session.webrtcPort,
                },
                wsPath: access.wsPath,
                username: access.username,
                password: access.password,
                iceServers: access.iceServers,
                allowClipboard: access.allowClipboard,
                allowDownloads: access.allowDownloads,
            };
        }
        catch (error) {
            const statusCode = error.statusCode ?? 500;
            const message = error instanceof Error ? error.message : "join_failed";
            if (statusCode >= 400 && statusCode < 500) {
                return reply.code(statusCode).send({ error: message });
            }
            request.log.error({ err: error }, "admin join failed");
            return reply.code(502).send({ error: "neko_unavailable" });
        }
    });
    app.delete("/api/admin/sessions/:sessionId", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const user = request.authUser;
        const session = browsers.getById(request.params.sessionId);
        if (!session) {
            return reply.code(404).send({ error: "not_found" });
        }
        const destroyed = await browsers.destroyById(session.id);
        if (destroyed) {
            audit.record({
                actorUsername: user.username,
                action: "terminate",
                sessionId: session.id,
                ownerUsername: session.ownerUsername,
                detail: `terminated ${session.browser} session for ${session.ownerUsername}`,
            });
        }
        return { ok: true, destroyed };
    });
    app.get("/api/admin/audit", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        const query = request.query ?? {};
        const filter = { limit: 500 };
        if (query.limit !== undefined && query.limit !== "") {
            const limit = Number(query.limit);
            if (!Number.isFinite(limit)) {
                return reply.code(400).send({ error: "invalid_limit" });
            }
            filter.limit = limit;
        }
        if (query.from !== undefined && query.from !== "") {
            const from = Date.parse(query.from);
            if (!Number.isFinite(from)) {
                return reply.code(400).send({ error: "invalid_from" });
            }
            filter.from = from;
        }
        if (query.to !== undefined && query.to !== "") {
            const to = Date.parse(query.to);
            if (!Number.isFinite(to)) {
                return reply.code(400).send({ error: "invalid_to" });
            }
            filter.to = to;
        }
        if (query.actor?.trim()) {
            filter.actor = query.actor.trim();
        }
        if (query.action?.trim()) {
            const action = query.action.trim();
            if (!(0, audit_store_1.isAuditAction)(action)) {
                return reply.code(400).send({ error: "invalid_action" });
            }
            filter.action = action;
        }
        const events = audit.list(filter).map((event) => ({
            id: event.id,
            actor: event.actorUsername,
            action: event.action,
            sessionId: event.sessionId,
            owner: event.ownerUsername,
            detail: event.detail,
            createdAt: new Date(event.createdAt).toISOString(),
        }));
        return {
            events,
            catalog: audit_store_1.AUDIT_ACTION_DEFS,
            enabledActions: config.auditEnabledActions,
        };
    });
    app.get("/api/admin/settings", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        return settings.list();
    });
    app.put("/api/admin/settings", {
        schema: {
            body: {
                type: "object",
                required: ["settings"],
                additionalProperties: false,
                properties: {
                    settings: {
                        type: "object",
                        additionalProperties: { type: "string" },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        try {
            const actor = request.authUser.username;
            const result = settings.update(request.body.settings ?? {});
            if (result.updated.length > 0) {
                audit.record({
                    actorUsername: actor,
                    action: "update_settings",
                    detail: `updated ${result.updated.join(", ")}`,
                });
            }
            request.log.info({ actor, updated: result.updated }, "admin settings updated");
            return { ok: true, ...result, ...settings.list() };
        }
        catch (error) {
            const status = error.statusCode ?? 400;
            const message = error instanceof Error ? error.message : "invalid_settings";
            return reply.code(status).send({ error: "invalid_settings", detail: message });
        }
    });
}
//# sourceMappingURL=admin.js.map