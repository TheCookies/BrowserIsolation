import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import type { BrowserType } from "../config";
import { NEKO_BROWSERS } from "../neko-browsers";

type LaunchBody = {
  browser: BrowserType;
};

const BROWSER_IDS = NEKO_BROWSERS.map((browser) => browser.id);

function publicSession(session: {
  id: string;
  ownerUsername: string;
  browser: BrowserType;
  createdAt: number;
  lastActivityAt: number;
  webrtcPort: number;
}) {
  return {
    id: session.id,
    owner: session.ownerUsername,
    browser: session.browser,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    webrtcPort: session.webrtcPort,
  };
}

export function registerSessionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { browsers, config, audit } = deps;

  app.get("/api/browsers", async (request, reply) => {
    if (!request.authUser || !request.portalSession) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const enabled = new Set(config.enabledBrowsers);
    return {
      browsers: NEKO_BROWSERS.filter((browser) => enabled.has(browser.id)).map((browser) => ({
        id: browser.id,
        title: browser.title,
        description: browser.description,
        family: browser.family,
        logo: browser.logo,
      })),
    };
  });

  app.get("/api/sessions/mine", async (request, reply) => {
    if (!request.authUser || !request.portalSession) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const session = browsers.getMine(request.authUser.username);
    if (!session) {
      return { session: null };
    }
    return { session: publicSession(session) };
  });

  app.post<{ Body: LaunchBody }>(
    "/api/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["browser"],
          additionalProperties: false,
          properties: {
            browser: { type: "string", enum: BROWSER_IDS },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser || !request.portalSession) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      try {
        const user = request.authUser;
        const result = await browsers.launch(user, request.body.browser);
        if (!result.reconnect) {
          audit.record({
            actorUsername: user.username,
            action: "create_session",
            sessionId: result.session.id,
            ownerUsername: user.username,
            detail: `launched ${result.session.browser}`,
          });
        }
        return {
          session: publicSession(result.session),
          reconnect: result.reconnect,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "launch_failed";
        if (message === "webrtc_port_pool_exhausted") {
          return reply.code(503).send({ error: message });
        }
        if (message === "browser_disabled" || message === "invalid_browser") {
          return reply.code(400).send({ error: message });
        }
        request.log.error({ err: error }, "browser launch failed");
        return reply.code(500).send({
          error: "launch_failed",
          detail: message.slice(0, 500),
        });
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      if (!request.authUser || !request.portalSession) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      try {
        const session = browsers.assertAccess(request.authUser, request.params.sessionId);
        return { session: publicSession(session) };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        const message = error instanceof Error ? error.message : "request_failed";
        return reply.code(statusCode).send({ error: message });
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/access",
    async (request, reply) => {
      if (!request.authUser || !request.portalSession) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      try {
        const access = await browsers.issueAccess(request.authUser, request.params.sessionId);
        return {
          session: publicSession(access.session),
          wsPath: access.wsPath,
          username: access.username,
          password: access.password,
          iceServers: access.iceServers,
          allowClipboard: access.allowClipboard,
          allowDownloads: access.allowDownloads,
        };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
        const message = error instanceof Error ? error.message : "access_failed";
        if (statusCode >= 400 && statusCode < 500) {
          return reply.code(statusCode).send({ error: message });
        }
        request.log.error({ err: error }, "session access failed");
        return reply.code(502).send({ error: "neko_unavailable" });
      }
    },
  );

  app.delete("/api/sessions/mine", async (request, reply) => {
    if (!request.authUser || !request.portalSession) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const user = request.authUser;
    const existing = browsers.getMine(user.username);
    const destroyed = await browsers.destroyForUser(user.username);
    if (destroyed && existing) {
      audit.record({
        actorUsername: user.username,
        action: "destroy_session",
        sessionId: existing.id,
        ownerUsername: user.username,
        detail: `ended ${existing.browser} session`,
      });
    }
    return { ok: true, destroyed };
  });
}
