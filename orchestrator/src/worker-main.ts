import path from "node:path";
import { loadConfig } from "./config";
import { createDockerRuntime } from "./docker/container-runtime";
import { LABEL_WEBRTC_PORT } from "./docker/labels";
import { loadEnvFile } from "./env-file";
import { buildWorkerAgent } from "./worker-agent/app";
import { createMemoryPortPool } from "./workers/memory-port-pool";

async function main(): Promise<void> {
  const baseDir = path.resolve(__dirname, "../..");
  loadEnvFile(path.join(baseDir, ".env"));
  const configDir = process.env.CONFIG_DIR?.trim() || "/config";
  loadEnvFile(path.join(configDir, ".env"), { override: true });
  const config = loadConfig(process.env, baseDir);

  const workerId = process.env.WORKER_ID?.trim() || "worker";
  const token = process.env.WORKER_TOKEN?.trim();
  if (!token) {
    throw new Error("WORKER_TOKEN is required for the worker agent.");
  }

  const port = Number(process.env.WORKER_PORT?.trim() || "8090");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORKER_PORT must be an integer from 1 to 65535.");
  }

  const runtime = createDockerRuntime(config);
  await runtime.ensureNetwork();
  const ports = createMemoryPortPool(config.webrtcPortStart, config.webrtcPortEnd);

  // Reclaim ports for containers already running on this host.
  for (const container of await runtime.listManaged()) {
    const port = Number(container.labels[LABEL_WEBRTC_PORT]);
    if (ports.isInRange(port)) ports.reserve(port);
  }

  const app = await buildWorkerAgent({
    config,
    workerId,
    token,
    runtime,
    ports,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "worker shutting down");
    await app.close();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT")
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  });

  await app.listen({ port, host: config.host });
  app.log.info(
    {
      workerId,
      port,
      publicIp: config.publicIp,
      webrtc: `${config.webrtcPortStart}-${config.webrtcPortEnd}`,
    },
    "worker agent listening",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
