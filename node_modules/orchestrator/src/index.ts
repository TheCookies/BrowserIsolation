import path from "node:path";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { loadEnvFile } from "./env-file";
import { createLocalAuthProvider } from "./auth/local-provider";
import { createLocalUserStore, seedLocalUsersIfEmpty } from "./auth/local-user-store";
import { buildApp } from "./app";
import { createAuditStore } from "./audit-store";
import { createBrowserSessionStore } from "./browser-session-store";
import { createBrowserSessionService } from "./browser-sessions";
import { createDockerRuntime } from "./docker/container-runtime";
import {
  reconcileBrowserSessions,
  startBrowserReaper,
  type LifecycleDeps,
} from "./lifecycle";
import { createPortPool } from "./port-pool";
import { createSessionStore } from "./session-store";
import { createSettingsStore } from "./settings-store";
import { createUserPreferencesStore } from "./user-preferences";
import { createViewerTracker } from "./viewer-tracker";
import { createRemoteWorkerClient } from "./workers/client";
import { createWorkerPlacement } from "./workers/placement";
import { createWorkerPoller } from "./workers/scheduler";
import { createWorkerStore, parseWorkersEnv } from "./workers/store";

async function main(): Promise<void> {
  const baseDir = path.resolve(__dirname, "../..");
  // Compose/local: /app/.env. Alma/Podman: host-mounted /config/.env (wins).
  loadEnvFile(path.join(baseDir, ".env"));
  const configDir = process.env.CONFIG_DIR?.trim() || "/config";
  loadEnvFile(path.join(configDir, ".env"), { override: true });
  const config = loadConfig(process.env, baseDir);
  const db = openDatabase(config.databasePath);
  const settings = createSettingsStore(db, config);
  settings.hydrateConfig();
  const sessions = createSessionStore(db, () => config.sessionTtlMs);
  sessions.deleteExpired();
  const browserStore = createBrowserSessionStore(db);
  const preferences = createUserPreferencesStore(db);
  const audit = createAuditStore(db, {
    isEnabled: (action) => config.auditEnabledActions.includes(action),
  });
  const viewers = createViewerTracker();
  const localPorts = createPortPool(db, config.webrtcPortStart, config.webrtcPortEnd);
  const localRuntime = createDockerRuntime(config);
  const workerStore = createWorkerStore(db);

  if (config.localWorkerEnabled) {
    workerStore.upsert({
      id: "local",
      baseUrl: "",
      publicIp: config.publicIp,
      token: "",
      enabled: true,
      kind: "local",
      lastSeenAt: Date.now(),
      activeSessions: browserStore.countByWorker("local"),
    });
  } else {
    const local = workerStore.get("local");
    if (local) workerStore.setEnabled("local", false);
  }

  for (const entry of parseWorkersEnv(config.workersBootstrap)) {
    workerStore.upsert({
      id: entry.id,
      baseUrl: entry.baseUrl,
      publicIp: entry.publicIp,
      token: entry.token,
      enabled: true,
      kind: "remote",
    });
  }

  const placement = createWorkerPlacement({
    config,
    store: workerStore,
    localRuntime,
    localPorts,
  });

  const browsers = createBrowserSessionService({
    config,
    store: browserStore,
    placement,
    preferences,
  });
  const localUsers = createLocalUserStore(db);
  const seeded = await seedLocalUsersIfEmpty(localUsers, config.authUsers, config.bcryptRounds);
  const auth = await createLocalAuthProvider(localUsers, config.bcryptRounds);
  const app = await buildApp({
    config,
    auth,
    sessions,
    browsers,
    audit,
    viewers,
    preferences,
    settings,
    localUsers,
    runtime: localRuntime,
    placement,
    workerStore,
    logger: true,
  });
  if (seeded > 0) {
    app.log.info({ seeded }, "seeded local users from AUTH_USERS");
  }

  const lifecycle: LifecycleDeps = {
    config,
    store: browserStore,
    placement,
    viewers,
  };

  let closing = false;
  let stopReaper: (() => void) | null = null;
  let stopPoller: (() => void) | null = null;

  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    stopReaper?.();
    stopPoller?.();
    app.log.info({ signal }, "shutting down");
    await app.close();
    db.close();
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

  try {
    if (config.localWorkerEnabled) {
      await localRuntime.ensureNetwork();
    }
    const reconciled = await reconcileBrowserSessions(lifecycle, app.log);
    app.log.info(reconciled, "browser session reconciliation complete");
    const reaper = startBrowserReaper(lifecycle, app.log);
    stopReaper = reaper.stop;

    const poller = createWorkerPoller({
      store: workerStore,
      intervalMs: 15_000,
      log: app.log,
      async pollRemote(worker) {
        const client = createRemoteWorkerClient({
          baseUrl: worker.baseUrl,
          token: worker.token,
        });
        const status = await client.status();
        return { activeSessions: status.activeSessions, publicIp: status.publicIp };
      },
    });
    stopPoller = poller.stop;
    void poller.runOnce();

    app.log.info(
      {
        publicIp: config.publicIp,
        browserNetworkMode: config.browserNetworkMode,
        webrtcPorts: `${config.webrtcPortStart}-${config.webrtcPortEnd}`,
      },
      "orchestrator network config",
    );
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    stopReaper?.();
    stopPoller?.();
    db.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
