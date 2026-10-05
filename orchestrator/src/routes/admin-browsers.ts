import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app";
import { imagesForBrowsers } from "../config";
import {
  imageForNekoBrowser,
  NEKO_BROWSERS,
  normalizeBrowserId,
  parseEnabledBrowsers,
  type BrowserType,
} from "../neko-browsers";

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

function catalogPayload(config: AppDeps["config"]) {
  const enabled = new Set(config.enabledBrowsers);
  return {
    tag: config.nekoImageTag,
    browsers: NEKO_BROWSERS.map((browser) => ({
      id: browser.id,
      title: browser.title,
      description: browser.description,
      family: browser.family,
      logo: browser.logo,
      image: imageForNekoBrowser(browser, config.nekoImageTag),
      enabled: enabled.has(browser.id),
    })),
  };
}

export function registerAdminBrowserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, settings, placement, audit, workerStore } = deps;

  app.get("/api/admin/browsers", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return catalogPayload(config);
  });

  app.put<{ Body: { enabled: string[] } }>(
    "/api/admin/browsers",
    {
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
    },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      // Image deletes can take a while across workers.
      request.raw.setTimeout(30 * 60 * 1000);
      reply.raw.setTimeout(30 * 60 * 1000);

      try {
        const previous = [...config.enabledBrowsers];
        const previousSet = new Set(previous);
        const normalized = request.body.enabled
          .map((id) => normalizeBrowserId(id))
          .filter((id): id is BrowserType => Boolean(id));
        parseEnabledBrowsers(normalized.join(","));

        const nextSet = new Set(normalized);
        const added = normalized.filter((id) => !previousSet.has(id));
        const removed = previous.filter((id) => !nextSet.has(id));

        settings.setEnabledBrowsers(normalized);

        const keptImages = new Set(imagesForBrowsers(config, normalized));
        const pullImages = imagesForBrowsers(config, added);
        const removeTargets = imagesForBrowsers(config, removed).filter(
          (image) => !keptImages.has(image),
        );

        const removedImages =
          removeTargets.length > 0 ? await placement.removeImages(removeTargets) : [];
        const removeFailed = removedImages.filter((row) => !row.ok);

        const detailParts = [`enabled browsers: ${normalized.join(", ")}`];
        if (added.length) detailParts.push(`added: ${added.join(", ")}`);
        if (removed.length) detailParts.push(`removed: ${removed.join(", ")}`);
        if (removeTargets.length) {
          detailParts.push(
            removeFailed.length === 0
              ? `deleted ${removeTargets.length} image(s)`
              : `deleted images with errors (${removeFailed.length} failed)`,
          );
        }

        audit.record({
          actorUsername: request.authUser!.username,
          action: "update_browsers",
          detail: detailParts.join("; "),
        });

        return {
          ok: true,
          ...catalogPayload(config),
          added,
          removed,
          pullImages,
          removedImages,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_browsers";
        return reply.code(400).send({ error: "invalid_browsers", message });
      }
    },
  );

  app.post("/api/admin/browsers/pull", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    // Docker pulls can take several minutes for multiple images.
    request.raw.setTimeout(30 * 60 * 1000);
    reply.raw.setTimeout(30 * 60 * 1000);

    const images = imagesForBrowsers(config, config.enabledBrowsers);
    const results = await placement.pullImages(images);
    const failed = results.filter((result) => !result.ok);
    const okCount = results.length - failed.length;
    audit.record({
      actorUsername: request.authUser!.username,
      action: "pull_browsers",
      detail:
        failed.length === 0
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
  app.post<{ Body: { images?: string[] } }>("/api/admin/browsers/pull/stream", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    request.raw.setTimeout(30 * 60 * 1000);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (payload: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const requested = Array.isArray(request.body?.images)
        ? request.body.images.map(String).filter((image) => image.trim().length > 0)
        : [];
      const unique =
        requested.length > 0
          ? [...new Set(requested)]
          : imagesForBrowsers(config, config.enabledBrowsers);

      if (unique.length === 0) {
        send({ type: "error", message: "No images to pull." });
        return;
      }

      send({
        type: "start",
        tag: config.nekoImageTag,
        images: unique,
        workers: workerStore.list().filter((w) => w.enabled).map((w) => w.id),
        message: (() => {
          const hosts = workerStore.list().filter((w) => w.enabled);
          const hostLabel =
            hosts.length === 0
              ? "no enabled workers"
              : `${hosts.length} host(s) (${hosts.map((w) => w.id).join(", ")})`;
          return `Pulling ${unique.length} image(s) on ${hostLabel} at tag ${config.nekoImageTag}…`;
        })(),
      });

      const results = await placement.pullImages(unique, (event) => {
        send({ type: "progress", ...event });
      });
      const failed = results.filter((result) => !result.ok);
      const okCount = results.length - failed.length;
      const hostIds = [...new Set(results.map((row) => row.workerId))];
      audit.record({
        actorUsername: request.authUser!.username,
        action: "pull_browsers",
        detail:
          failed.length === 0
            ? `pulled ${okCount} image(s) on ${hostIds.length} host(s) [${hostIds.join(", ")}] (tag ${config.nekoImageTag})`
            : `pulled ${okCount}/${results.length} image(s) on [${hostIds.join(", ")}]; failed: ${failed
                .map((row) => `${row.image}@${row.workerId}`)
                .join(", ")}`,
      });
      send({
        type: "done",
        ok: failed.length === 0,
        tag: config.nekoImageTag,
        results,
        message:
          failed.length === 0
            ? `Finished: pulled ${okCount} image(s).`
            : `Finished with errors: ${okCount}/${results.length} succeeded.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "error", message });
    } finally {
      reply.raw.end();
    }
  });
}
