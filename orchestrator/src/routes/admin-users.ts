import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app";
import { isRole } from "../auth/provider";

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
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

function publicUser(user: {
  username: string;
  role: string;
  subjectId: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    username: user.username,
    role: user.role,
    subjectId: user.subjectId,
    createdAt: new Date(user.createdAt).toISOString(),
    updatedAt: new Date(user.updatedAt).toISOString(),
  };
}

export function registerAdminUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, localUsers, sessions, browsers, audit } = deps;

  app.get("/api/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { users: localUsers.list().map(publicUser) };
  });

  app.post<{ Body: { username?: string; password?: string; role?: string } }>(
    "/api/admin/users",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "password", "role"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 64 },
            password: { type: "string", minLength: 1, maxLength: 256 },
            role: { type: "string", enum: ["user", "admin"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const role = request.body.role ?? "";
      if (!isRole(role)) {
        return reply.code(400).send({ error: "invalid_role" });
      }
      try {
        const actor = request.authUser!.username;
        const user = await localUsers.create(
          {
            username: String(request.body.username ?? ""),
            password: String(request.body.password ?? ""),
            role,
          },
          config.bcryptRounds,
        );
        audit.record({
          actorUsername: actor,
          action: "create_user",
          ownerUsername: user.username,
          detail: `created ${user.role} account ${user.username}`,
        });
        request.log.info(
          { actor, username: user.username, role: user.role },
          "local user created",
        );
        return reply.code(201).send({ user: publicUser(user) });
      } catch (error) {
        const code = error instanceof Error ? error.message : "create_failed";
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: code });
      }
    },
  );

  app.patch<{
    Params: { username: string };
    Body: { role?: string; password?: string };
  }>(
    "/api/admin/users/:username",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: ["user", "admin"] },
            password: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const username = request.params.username;
      const body = request.body ?? {};
      if (body.role === undefined && body.password === undefined) {
        return reply.code(400).send({ error: "empty_patch" });
      }

      try {
        const actor = request.authUser!.username;
        let user = localUsers.get(username);
        if (!user) return reply.code(404).send({ error: "not_found" });
        const previousRole = user.role;

        if (body.role !== undefined) {
          if (!isRole(body.role)) return reply.code(400).send({ error: "invalid_role" });
          user = localUsers.setRole(username, body.role);
          sessions.updateRoleForUsername(username, body.role);
          if (previousRole !== body.role) {
            audit.record({
              actorUsername: actor,
              action: "update_user_role",
              ownerUsername: username,
              detail: `changed role ${previousRole} → ${body.role}`,
            });
          }
        }
        if (body.password !== undefined) {
          user = await localUsers.setPassword(username, body.password, config.bcryptRounds);
          sessions.deleteForUsername(username);
          audit.record({
            actorUsername: actor,
            action: "reset_user_password",
            ownerUsername: username,
            detail: `reset password for ${username}`,
          });
        }

        request.log.info(
          {
            actor,
            username,
            roleChanged: body.role !== undefined,
            passwordChanged: body.password !== undefined,
          },
          "local user updated",
        );
        return { user: publicUser(user) };
      } catch (error) {
        const code = error instanceof Error ? error.message : "update_failed";
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: code });
      }
    },
  );

  app.delete<{ Params: { username: string } }>(
    "/api/admin/users/:username",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const username = request.params.username;
      if (username === request.authUser!.username) {
        return reply.code(400).send({ error: "cannot_delete_self" });
      }
      try {
        const existed = localUsers.get(username);
        if (!existed) return reply.code(404).send({ error: "not_found" });
        const actor = request.authUser!.username;
        localUsers.delete(username);
        sessions.deleteForUsername(username);
        try {
          await browsers.destroyForUser(username);
        } catch (error) {
          request.log.error({ err: error, username }, "failed to destroy browser after user delete");
        }
        audit.record({
          actorUsername: actor,
          action: "delete_user",
          ownerUsername: username,
          detail: `deleted ${existed.role} account ${username}`,
        });
        request.log.info({ actor, username }, "local user deleted");
        return { ok: true };
      } catch (error) {
        const code = error instanceof Error ? error.message : "delete_failed";
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: code });
      }
    },
  );
}
