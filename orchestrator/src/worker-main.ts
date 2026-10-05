import path from "node:path";
import { loadConfig } from "./config";
import { createDockerRuntime } from "./docker/container-runtime";
import { LABEL_WEBRTC_PORT } from "./docker/labels";
import { loadEnvFile } from "./env-file";
import { buildWorkerAgent } from "./worker-agent/app";
import { enrollWithOrchestrator } from "./workers/enroll-client";
import { createMemoryPortPool } from "./workers/memory-port-pool";

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

async function main(): Promise<void> {
  const baseDir = path.resolve(__dirname, "../..");
  loadEnvFile(path.join(baseDir, ".env"));
  const configDir = process.env.CONFIG_DIR?.trim() || "/config";
  loadEnvFile(path.join(configDir, ".env"), { override: true });
  const config = loadConfig(process.env, baseDir);

  const workerId = process.env.WORKER_ID?.trim() || "worker";
  const enrollToken = process.env.WORKER_ENROLL_TOKEN?.trim() || "";
  const legacyToken = process.env.WORKER_TOKEN?.trim() || "";
  // Prefer the shared enroll secret; keep legacy WORKER_TOKEN as a fallback acceptor
  // so older .env files keep working during rollout.
  const tokens = uniqueNonEmpty([enrollToken, legacyToken]);
  if (tokens.length === 0) {
    throw new Error("WORKER_ENROLL_TOKEN or WORKER_TOKEN is required for the worker agent.");
  }

  const port = Number(process.env.WORKER_PORT?.trim() || "8090");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORKER_PORT must be an integer from 1 to 65535.");
  }

  const orchestratorUrl = (
    process.env.ORCHESTRATOR_URL?.trim() ||
    process.env.PUBLIC_BASE_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  const publicIp = config.publicIp;
  const baseUrl =
    process.env.WORKER_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://${publicIp}:${port}`;

  if (orchestratorUrl && enrollToken) {
    try {
      const enrolled = await enrollWithOrchestrator({
        orchestratorBaseUrl: orchestratorUrl,
        enrollToken,
        workerId,
        baseUrl,
        publicIp,
      });
      console.log(
        JSON.stringify({
          msg: "worker enrolled with orchestrator",
          workerId: enrolled.id,
          enabled: enrolled.enabled,
          orchestratorUrl,
        }),
      );
    } catch (error) {
      // Still listen — installer may have enrolled already; admin can authorize later.
      console.error(
        JSON.stringify({
          msg: "worker enroll failed; continuing with local agent token",
          error: error instanceof Error ? error.message : String(error),
          orchestratorUrl,
        }),
      );
    }
  } else {
    console.log(
      JSON.stringify({
        msg: "skipping auto-enroll (set ORCHESTRATOR_URL and WORKER_ENROLL_TOKEN to enable)",
      }),
    );
  }

  const runtime = createDockerRuntime(config);
  await runtime.ensureNetwork();
  const ports = createMemoryPortPool(config.webrtcPortStart, config.webrtcPortEnd);

  // Reclaim ports for containers already running on this host.
  for (const container of await runtime.listManaged()) {
    const labeledPort = Number(container.labels[LABEL_WEBRTC_PORT]);
    if (ports.isInRange(labeledPort)) ports.reserve(labeledPort);
  }

  const app = await buildWorkerAgent({
    config,
    workerId,
    tokens,
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
      acceptedTokens: tokens.length,
    },
    "worker agent listening",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
