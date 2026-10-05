import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app";
import { decodeLogoDataUrlOrBase64 } from "../branding-store";

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

type UploadBody = {
  contentType?: string;
  data?: string;
  filename?: string;
};

export function registerBrandingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { branding, audit } = deps;

  app.get("/branding/logo", async (_request, reply) => {
    const logo = branding.readLogo();
    if (!logo) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "public, max-age=86400");
    return reply.type(logo.contentType).send(logo.buffer);
  });

  app.get("/api/admin/branding", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { logo: branding.getLogoInfo() };
  });

  app.put<{ Body: UploadBody }>(
    "/api/admin/branding/logo",
    {
      schema: {
        body: {
          type: "object",
          required: ["contentType", "data"],
          additionalProperties: false,
          properties: {
            contentType: { type: "string", minLength: 3, maxLength: 64 },
            data: { type: "string", minLength: 1, maxLength: 2_000_000 },
            filename: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        const buffer = decodeLogoDataUrlOrBase64(String(request.body.data ?? ""));
        const logo = branding.saveLogo({
          buffer,
          contentType: String(request.body.contentType ?? ""),
          filename: request.body.filename,
        });
        audit.record({
          actorUsername: request.authUser!.username,
          action: "update_settings",
          detail: `uploaded site logo (${logo.filename})`,
        });
        return { ok: true, logo };
      } catch (error) {
        const code = error instanceof Error ? error.message : "upload_failed";
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        return reply.code(status).send({ error: code });
      }
    },
  );

  app.delete("/api/admin/branding/logo", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const removed = branding.removeLogo();
    if (removed) {
      audit.record({
        actorUsername: request.authUser!.username,
        action: "update_settings",
        detail: "removed site logo",
      });
    }
    return { ok: true, removed };
  });
}
