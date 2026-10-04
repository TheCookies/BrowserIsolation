"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPreferenceRoutes = registerPreferenceRoutes;
function registerPreferenceRoutes(app, deps) {
    const { config, preferences } = deps;
    app.get("/api/preferences", async (request, reply) => {
        if (!request.authUser)
            return reply.code(401).send({ error: "unauthenticated" });
        const prefs = preferences.get(request.authUser.subjectId);
        return {
            persistProfilesEnabled: config.persistProfilesEnabled,
            persistProfile: config.persistProfilesEnabled ? prefs.persistProfile : false,
            subjectId: request.authUser.subjectId,
        };
    });
    app.put("/api/preferences", {
        schema: {
            body: {
                type: "object",
                required: ["persistProfile"],
                additionalProperties: false,
                properties: {
                    persistProfile: { type: "boolean" },
                },
            },
        },
    }, async (request, reply) => {
        if (!request.authUser)
            return reply.code(401).send({ error: "unauthenticated" });
        if (!config.persistProfilesEnabled) {
            return reply.code(403).send({ error: "persist_profiles_disabled" });
        }
        const prefs = preferences.setPersistProfile(request.authUser.subjectId, Boolean(request.body.persistProfile));
        return {
            persistProfilesEnabled: true,
            persistProfile: prefs.persistProfile,
            subjectId: request.authUser.subjectId,
        };
    });
}
//# sourceMappingURL=preferences.js.map