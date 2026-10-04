"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionCookie = sessionCookie;
exports.csrfCookie = csrfCookie;
exports.clearCookieOptions = clearCookieOptions;
exports.buildApp = buildApp;
const node_path_1 = __importDefault(require("node:path"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const formbody_1 = __importDefault(require("@fastify/formbody"));
const static_1 = __importDefault(require("@fastify/static"));
const fastify_1 = __importDefault(require("fastify"));
const admin_1 = require("./routes/admin");
const admin_browsers_1 = require("./routes/admin-browsers");
const admin_users_1 = require("./routes/admin-users");
const admin_volumes_1 = require("./routes/admin-volumes");
const admin_workers_1 = require("./routes/admin-workers");
const auth_1 = require("./routes/auth");
const preferences_1 = require("./routes/preferences");
const sessions_1 = require("./routes/sessions");
const proxy_1 = require("./proxy");
const security_1 = require("./security");
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function cookieBase(config) {
    return {
        path: "/",
        sameSite: "lax",
        secure: config.cookieSecure,
        httpOnly: true,
    };
}
function sessionCookie(config) {
    return {
        ...cookieBase(config),
        maxAge: Math.floor(config.sessionTtlMs / 1000),
    };
}
function csrfCookie(config) {
    return {
        ...cookieBase(config),
        maxAge: 10 * 60,
    };
}
function clearCookieOptions(config) {
    return cookieBase(config);
}
function csrfAccepted(request, config, token) {
    if (request.portalSession) {
        return (0, security_1.safeEqual)(token, request.portalSession.csrfToken);
    }
    const cookieToken = request.cookies[config.csrfCookieName];
    if (!cookieToken)
        return false;
    return (0, security_1.safeEqual)(token, cookieToken);
}
async function buildApp(deps) {
    const { config, sessions } = deps;
    const app = (0, fastify_1.default)({
        logger: deps.logger
            ? {
                level: "info",
                redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
            }
            : false,
        trustProxy: config.trustProxy,
    });
    await app.register(cookie_1.default);
    await app.register(formbody_1.default);
    app.decorateRequest("authUser", null);
    app.decorateRequest("portalSession", null);
    app.addHook("onRequest", async (request) => {
        request.authUser = null;
        request.portalSession = null;
        const sessionId = request.cookies[config.cookieName];
        if (!sessionId)
            return;
        const session = sessions.get(sessionId);
        if (!session)
            return;
        request.portalSession = session;
        request.authUser = {
            username: session.username,
            role: session.role,
            subjectId: session.subjectId,
        };
    });
    app.addHook("onRequest", async (request, reply) => {
        if (!MUTATING.has(request.method))
            return;
        const pathOnly = request.url.split("?")[0] ?? request.url;
        if (!pathOnly.startsWith("/api/"))
            return;
        // IdP browser POST — no portal CSRF cookie.
        if (pathOnly === "/api/auth/saml/acs")
            return;
        const header = request.headers["x-csrf-token"];
        const token = Array.isArray(header) ? header[0] : header;
        if (!token || !csrfAccepted(request, config, token)) {
            return reply.code(403).send({ error: "csrf_failed" });
        }
    });
    app.addHook("onSend", async (request, reply, payload) => {
        reply.header("x-content-type-options", "nosniff");
        reply.header("x-frame-options", "SAMEORIGIN");
        reply.header("referrer-policy", "same-origin");
        reply.header("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: *; worker-src 'self' blob:; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
        const pathOnly = request.url.split("?")[0] ?? request.url;
        if (pathOnly.startsWith("/api/")) {
            reply.header("cache-control", "no-store");
        }
        return payload;
    });
    app.get("/api/health", async () => ({ ok: true }));
    (0, auth_1.registerAuthRoutes)(app, deps);
    (0, preferences_1.registerPreferenceRoutes)(app, deps);
    (0, admin_1.registerAdminRoutes)(app, deps);
    (0, admin_browsers_1.registerAdminBrowserRoutes)(app, deps);
    (0, admin_users_1.registerAdminUserRoutes)(app, deps);
    (0, admin_volumes_1.registerAdminVolumeRoutes)(app, deps);
    (0, admin_workers_1.registerAdminWorkerRoutes)(app, deps);
    (0, sessions_1.registerSessionRoutes)(app, deps);
    await (0, proxy_1.registerSessionProxy)(app, deps);
    if (config.staticDir) {
        const staticDir = config.staticDir;
        await app.register(static_1.default, {
            root: staticDir,
            decorateReply: true,
            setHeaders(res, filePath) {
                if (filePath.endsWith(`${node_path_1.default.sep}index.html`) || filePath.endsWith("/index.html")) {
                    res.setHeader("cache-control", "no-cache");
                    return;
                }
                if (filePath.includes(`${node_path_1.default.sep}assets${node_path_1.default.sep}`) || filePath.includes("/assets/")) {
                    res.setHeader("cache-control", "public, max-age=31536000, immutable");
                }
            },
        });
        app.setNotFoundHandler((request, reply) => {
            const urlPath = request.url.split("?")[0] ?? request.url;
            if (urlPath.startsWith("/api/") || urlPath.includes(".")) {
                return reply.code(404).send({ error: "not_found" });
            }
            reply.header("cache-control", "no-cache");
            return reply.type("text/html; charset=utf-8").sendFile("index.html");
        });
    }
    else {
        app.setNotFoundHandler((_request, reply) => {
            return reply.code(404).send({ error: "not_found" });
        });
    }
    app.setErrorHandler((error, request, reply) => {
        if (error.validation) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        const statusCode = error.statusCode ?? 500;
        if (statusCode >= 400 && statusCode < 500) {
            return reply.code(statusCode).send({ error: error.message || "request_failed" });
        }
        request.log.error({ err: error }, "request failed");
        return reply.code(500).send({ error: "internal_error" });
    });
    return app;
}
//# sourceMappingURL=app.js.map