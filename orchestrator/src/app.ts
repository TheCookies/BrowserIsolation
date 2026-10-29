import path from "node:path";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import type { AuditStore } from "./audit-store";
import type { AuthenticatedUser } from "./auth/provider";
import type { BrowserSessionService } from "./browser-sessions";
import type { Config } from "./config";
import type { ContainerRuntime } from "./docker/container-runtime";
import { registerAdminRoutes } from "./routes/admin";
import { registerAdminBrowserRoutes } from "./routes/admin-browsers";
import { registerAdminUserRoutes } from "./routes/admin-users";
import { registerAdminVolumeRoutes } from "./routes/admin-volumes";
import { registerAdminWorkerRoutes } from "./routes/admin-workers";
import { registerAuthRoutes } from "./routes/auth";
import { registerPreferenceRoutes } from "./routes/preferences";
import { registerSessionRoutes } from "./routes/sessions";
import { registerWorkerEnrollRoutes } from "./routes/workers-enroll";
import { registerSessionProxy } from "./proxy";
import { safeEqual } from "./security";
import type { PortalSession, SessionStore } from "./session-store";
import type { LocalUserStore } from "./auth/local-user-store";
import type { BrandingStore } from "./branding-store";
import { registerBrandingRoutes } from "./routes/branding";
import type { SettingsStore } from "./settings-store";
import type { UserPreferencesStore } from "./user-preferences";
import type { ViewerTracker } from "./viewer-tracker";
import { getAppVersion } from "./version";

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    portalSession: PortalSession | null;
  }
}

export type AppDeps = {
  config: Config;
  auth: import("./auth/provider").AuthProvider;
  sessions: SessionStore;
  browsers: BrowserSessionService;
  audit: AuditStore;
  viewers: ViewerTracker;
  preferences: UserPreferencesStore;
  settings: SettingsStore;
  localUsers: LocalUserStore;
  branding: BrandingStore;
  runtime: ContainerRuntime;
  placement: import("./workers/placement").WorkerPlacement;
  workerStore: import("./workers/store").WorkerStore;
  logger?: boolean;
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function cookieBase(config: Config) {
  return {
    path: "/",
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    httpOnly: true,
  };
}

export function sessionCookie(config: Config) {
  return {
    ...cookieBase(config),
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  };
}

export function csrfCookie(config: Config) {
  return {
    ...cookieBase(config),
    maxAge: 10 * 60,
  };
}

export function clearCookieOptions(config: Config) {
  return cookieBase(config);
}

function csrfAccepted(request: FastifyRequest, config: Config, token: string): boolean {
  if (request.portalSession) {
    return safeEqual(token, request.portalSession.csrfToken);
  }
  const cookieToken = request.cookies[config.csrfCookieName];
  if (!cookieToken) return false;
  return safeEqual(token, cookieToken);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, sessions } = deps;
  const app = Fastify({
    logger: deps.logger
      ? {
          level: "info",
          redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
        }
      : false,
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(formbody);

  app.decorateRequest("authUser", null);
  app.decorateRequest("portalSession", null);

  app.addHook("onRequest", async (request) => {
    request.authUser = null;
    request.portalSession = null;
    const sessionId = request.cookies[config.cookieName];
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    request.portalSession = session;
    request.authUser = {
      username: session.username,
      role: session.role,
      subjectId: session.subjectId,
    };
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING.has(request.method)) return;
    const pathOnly = request.url.split("?")[0] ?? request.url;
    if (!pathOnly.startsWith("/api/")) return;
    // IdP browser POST — no portal CSRF cookie.
    if (pathOnly === "/api/auth/saml/acs") return;
    // Worker bootstrap uses a shared enroll bearer token instead of CSRF.
    if (pathOnly === "/api/workers/enroll") return;
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
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: *; worker-src 'self' blob:; frame-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    );
    const pathOnly = request.url.split("?")[0] ?? request.url;
    if (pathOnly.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.get("/api/health", async () => {
    const ver = getAppVersion();
    return { ok: true, version: ver.version, gitSha: ver.gitShaShort };
  });
  registerAuthRoutes(app, deps);
  registerBrandingRoutes(app, deps);
  registerPreferenceRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerAdminBrowserRoutes(app, deps);
  registerAdminUserRoutes(app, deps);
  registerAdminVolumeRoutes(app, deps);
  registerAdminWorkerRoutes(app, deps);
  registerWorkerEnrollRoutes(app, deps);
  registerSessionRoutes(app, deps);
  await registerSessionProxy(app, deps);

  if (config.staticDir) {
    const staticDir = config.staticDir;
    await app.register(fastifyStatic, {
      root: staticDir,
      decorateReply: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith("/index.html")) {
          res.setHeader("cache-control", "no-cache");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes("/assets/")) {
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
  } else {
    app.setNotFoundHandler((_request, reply) => {
      return reply.code(404).send({ error: "not_found" });
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
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
