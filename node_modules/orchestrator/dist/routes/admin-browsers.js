"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminBrowserRoutes = registerAdminBrowserRoutes;
const config_1 = require("../config");
const neko_browsers_1 = require("../neko-browsers");
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
function catalogPayload(config) {
    const enabled = new Set(config.enabledBrowsers);
    return {
        tag: config.nekoImageTag,
        browsers: neko_browsers_1.NEKO_BROWSERS.map((browser) => ({
            id: browser.id,
            title: browser.title,
            description: browser.description,
            family: browser.family,
            logo: browser.logo,
            image: (0, neko_browsers_1.imageForNekoBrowser)(browser, config.nekoImageTag),
            enabled: enabled.has(browser.id),
        })),
    };
}
function registerAdminBrowserRoutes(app, deps) {
    const { config, settings, placement, audit } = deps;
    app.get("/api/admin/browsers", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        return catalogPayload(config);
    });
    app.put("/api/admin/browsers", {
        schema: {
            body: {
                type: "object",
                required: ["enabled"],
                additionalProperties: false,
                properties: {
                    enabled: {
                        type: "array",
                        items: { type: "string" },
                        minItems: 1,
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        try {
            const normalized = request.body.enabled
                .map((id) => (0, neko_browsers_1.normalizeBrowserId)(id))
                .filter((id) => Boolean(id));
            (0, neko_browsers_1.parseEnabledBrowsers)(normalized.join(","));
            settings.setEnabledBrowsers(normalized);
            audit.record({
                actorUsername: request.authUser.username,
                action: "update_browsers",
                detail: `enabled browsers: ${normalized.join(", ")}`,
            });
            return { ok: true, ...catalogPayload(config) };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "invalid_browsers";
            return reply.code(400).send({ error: "invalid_browsers", message });
        }
    });
    app.post("/api/admin/browsers/pull", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        // Docker pulls can take several minutes for multiple images.
        request.raw.setTimeout(30 * 60 * 1000);
        reply.raw.setTimeout(30 * 60 * 1000);
        const images = config.enabledBrowsers.map((id) => {
            const meta = (0, neko_browsers_1.getNekoBrowser)(id);
            if (!meta)
                throw new Error(`unknown browser ${id}`);
            return (0, config_1.imageForBrowser)(config, id);
        });
        const unique = [...new Set(images)];
        const results = await placement.pullImages(unique);
        const failed = results.filter((result) => !result.ok);
        const okCount = results.length - failed.length;
        audit.record({
            actorUsername: request.authUser.username,
            action: "pull_browsers",
            detail: failed.length === 0
                ? `pulled ${okCount} image(s) (tag ${config.nekoImageTag})`
                : `pulled ${okCount}/${results.length} image(s); failed: ${failed
                    .map((row) => row.image)
                    .join(", ")}`,
        });
        return {
            ok: failed.length === 0,
            tag: config.nekoImageTag,
            results,
        };
    });
    /** SSE stream of pull progress for the admin Pull modal. */
    app.post("/api/admin/browsers/pull/stream", async (request, reply) => {
        if (!requireAdmin(request, reply))
            return;
        request.raw.setTimeout(30 * 60 * 1000);
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        const send = (payload) => {
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        try {
            const images = config.enabledBrowsers.map((id) => {
                const meta = (0, neko_browsers_1.getNekoBrowser)(id);
                if (!meta)
                    throw new Error(`unknown browser ${id}`);
                return (0, config_1.imageForBrowser)(config, id);
            });
            const unique = [...new Set(images)];
            send({
                type: "start",
                tag: config.nekoImageTag,
                images: unique,
                message: `Pulling ${unique.length} image(s) at tag ${config.nekoImageTag}…`,
            });
            const results = await placement.pullImages(unique, (event) => {
                send({ type: "progress", ...event });
            });
            const failed = results.filter((result) => !result.ok);
            const okCount = results.length - failed.length;
            audit.record({
                actorUsername: request.authUser.username,
                action: "pull_browsers",
                detail: failed.length === 0
                    ? `pulled ${okCount} image(s) (tag ${config.nekoImageTag})`
                    : `pulled ${okCount}/${results.length} image(s); failed: ${failed
                        .map((row) => row.image)
                        .join(", ")}`,
            });
            send({
                type: "done",
                ok: failed.length === 0,
                tag: config.nekoImageTag,
                results,
                message: failed.length === 0
                    ? `Finished: pulled ${okCount} image(s).`
                    : `Finished with errors: ${okCount}/${results.length} succeeded.`,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send({ type: "error", message });
        }
        finally {
            reply.raw.end();
        }
    });
}
//# sourceMappingURL=admin-browsers.js.map