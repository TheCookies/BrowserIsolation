import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app";

type PreferencesBody = {
  persistProfile?: boolean;
  darkMode?: boolean;
};

export function registerPreferenceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, preferences } = deps;

  function serialize(subjectId: string) {
    const prefs = preferences.get(subjectId);
    return {
      persistProfilesEnabled: config.persistProfilesEnabled,
      persistProfile: config.persistProfilesEnabled ? prefs.persistProfile : false,
      darkMode: prefs.darkMode,
      subjectId,
    };
  }

  app.get("/api/preferences", async (request, reply) => {
    if (!request.authUser) return reply.code(401).send({ error: "unauthenticated" });
    return serialize(request.authUser.subjectId);
  });

  app.put<{ Body: PreferencesBody }>(
    "/api/preferences",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            persistProfile: { type: "boolean" },
            darkMode: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) return reply.code(401).send({ error: "unauthenticated" });
      const subjectId = request.authUser.subjectId;
      const { persistProfile, darkMode } = request.body;

      if (persistProfile !== undefined) {
        if (!config.persistProfilesEnabled) {
          return reply.code(403).send({ error: "persist_profiles_disabled" });
        }
        preferences.setPersistProfile(subjectId, Boolean(persistProfile));
      }
      if (darkMode !== undefined) {
        preferences.setDarkMode(subjectId, Boolean(darkMode));
      }

      return serialize(subjectId);
    },
  );
}
