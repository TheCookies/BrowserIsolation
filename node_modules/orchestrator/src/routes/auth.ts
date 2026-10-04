import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";
import { clearCookieOptions, csrfCookie, sessionCookie } from "../app";
import {
  createSamlClient,
  generateSpMetadata,
  profileToUser,
  samlServiceUrls,
} from "../auth/saml";
import { randomToken } from "../security";

type LoginBody = {
  username: string;
  password: string;
};

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, auth, sessions, browsers, preferences, audit } = deps;

  app.get("/api/auth/csrf", async (request, reply) => {
    if (request.portalSession) {
      return { csrfToken: request.portalSession.csrfToken };
    }
    const csrfToken = randomToken();
    reply.setCookie(config.csrfCookieName, csrfToken, csrfCookie(config));
    return { csrfToken };
  });

  app.get("/api/auth/methods", async () => {
    let entityId: string | null = null;
    let metadataUrl: string | null = null;
    let acsUrl: string | null = null;
    if (config.samlEnabled && config.publicBaseUrl.trim()) {
      try {
        const urls = samlServiceUrls(config);
        entityId = urls.entityId;
        metadataUrl = urls.metadataUrl;
        acsUrl = urls.acsUrl;
      } catch {
        /* incomplete config */
      }
    }
    return {
      local: true,
      saml: config.samlEnabled,
      ssoLabel: "Sign in with SSO",
      samlUrls: config.samlEnabled
        ? { entityId, metadataUrl, acsUrl, baseUrl: config.publicBaseUrl || null }
        : null,
    };
  });

  app.post<{ Body: LoginBody }>(
    "/api/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 64 },
            password: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await auth.authenticate(request.body.username, request.body.password);
      if (!user) {
        request.log.info("login failed");
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      if (request.portalSession) {
        sessions.delete(request.portalSession.id);
      }

      const session = sessions.create(user);
      reply.clearCookie(config.csrfCookieName, clearCookieOptions(config));
      reply.setCookie(config.cookieName, session.id, sessionCookie(config));
      request.log.info(
        { username: user.username, role: user.role, subjectId: user.subjectId },
        "login succeeded",
      );
      audit.record({
        actorUsername: user.username,
        action: "login",
        ownerUsername: user.username,
        detail: `password login (${user.role})`,
      });
      const prefs = preferences.get(user.subjectId);
      return {
        username: user.username,
        role: user.role,
        subjectId: user.subjectId,
        persistProfilesEnabled: config.persistProfilesEnabled,
        persistProfile: config.persistProfilesEnabled ? prefs.persistProfile : false,
        csrfToken: session.csrfToken,
      };
    },
  );

  app.get("/api/auth/saml/login", async (request, reply) => {
    if (!config.samlEnabled) {
      return reply.code(404).send({ error: "saml_disabled" });
    }
    try {
      const client = createSamlClient(config);
      const url = await client.getAuthorizeUrlAsync("", undefined, {});
      return reply.redirect(url);
    } catch (error) {
      request.log.error({ err: error }, "saml login redirect failed");
      return reply.code(500).send({ error: "saml_misconfigured" });
    }
  });

  app.post<{ Body: Record<string, string> }>("/api/auth/saml/acs", async (request, reply) => {
    if (!config.samlEnabled) {
      return reply.code(404).send({ error: "saml_disabled" });
    }
    try {
      const client = createSamlClient(config);
      const body = request.body ?? {};
      const { profile, loggedOut } = await client.validatePostResponseAsync(body);
      if (loggedOut || !profile) {
        return reply.code(400).send({ error: "saml_logout_or_empty" });
      }
      const user = profileToUser(profile, config);

      if (request.portalSession) {
        sessions.delete(request.portalSession.id);
      }
      const session = sessions.create(user);
      reply.clearCookie(config.csrfCookieName, clearCookieOptions(config));
      reply.setCookie(config.cookieName, session.id, sessionCookie(config));

      request.log.info(
        {
          username: user.username,
          role: user.role,
          subjectId: user.subjectId,
          via: "saml",
        },
        "saml login succeeded",
      );
      audit.record({
        actorUsername: user.username,
        action: "saml_login",
        ownerUsername: user.username,
        detail: `SAML SSO login (${user.role}, ${user.subjectId})`,
      });

      return reply.redirect("/");
    } catch (error) {
      request.log.warn({ err: error }, "saml ACS validation failed");
      return reply.code(401).type("text/html").send(
        `<!doctype html><html><body><h1>SSO sign-in failed</h1><p>The identity provider response could not be validated. Contact an administrator.</p><p><a href="/login">Back to login</a></p></body></html>`,
      );
    }
  });

  app.get("/saml/metadata", async (request, reply) => {
    if (!config.samlEnabled) {
      return reply.code(404).send({ error: "saml_disabled" });
    }
    try {
      const xml = generateSpMetadata(config);
      return reply.type("application/samlmetadata+xml").send(xml);
    } catch (error) {
      request.log.error({ err: error }, "saml metadata generation failed");
      return reply.code(500).send({ error: "saml_misconfigured" });
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (!request.authUser || !request.portalSession) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const user = request.authUser;
    try {
      await browsers.destroyForUser(user.username);
    } catch (error) {
      request.log.error({ err: error, username: user.username }, "failed to destroy browser on logout");
      return reply.code(500).send({ error: "logout_cleanup_failed" });
    }
    sessions.delete(request.portalSession.id);
    reply.clearCookie(config.cookieName, clearCookieOptions(config));
    request.log.info({ username: user.username, role: user.role }, "logout");
    audit.record({
      actorUsername: user.username,
      action: "logout",
      ownerUsername: user.username,
      detail: `logout (${user.role})`,
    });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    if (!request.authUser || !request.portalSession) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const prefs = preferences.get(request.authUser.subjectId);
    return {
      username: request.authUser.username,
      role: request.authUser.role,
      subjectId: request.authUser.subjectId,
      persistProfilesEnabled: config.persistProfilesEnabled,
      persistProfile: config.persistProfilesEnabled ? prefs.persistProfile : false,
      csrfToken: request.portalSession.csrfToken,
    };
  });
}
