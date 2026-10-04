"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const db_1 = require("./db");
const env_file_1 = require("./env-file");
const local_provider_1 = require("./auth/local-provider");
const local_user_store_1 = require("./auth/local-user-store");
const app_1 = require("./app");
const audit_store_1 = require("./audit-store");
const browser_session_store_1 = require("./browser-session-store");
const browser_sessions_1 = require("./browser-sessions");
const container_runtime_1 = require("./docker/container-runtime");
const lifecycle_1 = require("./lifecycle");
const port_pool_1 = require("./port-pool");
const session_store_1 = require("./session-store");
const settings_store_1 = require("./settings-store");
const user_preferences_1 = require("./user-preferences");
const viewer_tracker_1 = require("./viewer-tracker");
const client_1 = require("./workers/client");
const placement_1 = require("./workers/placement");
const scheduler_1 = require("./workers/scheduler");
const store_1 = require("./workers/store");
async function main() {
    const baseDir = node_path_1.default.resolve(__dirname, "../..");
    (0, env_file_1.loadEnvFile)(node_path_1.default.join(baseDir, ".env"));
    const config = (0, config_1.loadConfig)(process.env, baseDir);
    const db = (0, db_1.openDatabase)(config.databasePath);
    const settings = (0, settings_store_1.createSettingsStore)(db, config);
    settings.hydrateConfig();
    const sessions = (0, session_store_1.createSessionStore)(db, () => config.sessionTtlMs);
    sessions.deleteExpired();
    const browserStore = (0, browser_session_store_1.createBrowserSessionStore)(db);
    const preferences = (0, user_preferences_1.createUserPreferencesStore)(db);
    const audit = (0, audit_store_1.createAuditStore)(db);
    const viewers = (0, viewer_tracker_1.createViewerTracker)();
    const localPorts = (0, port_pool_1.createPortPool)(db, config.webrtcPortStart, config.webrtcPortEnd);
    const localRuntime = (0, container_runtime_1.createDockerRuntime)(config);
    const workerStore = (0, store_1.createWorkerStore)(db);
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
    }
    else {
        const local = workerStore.get("local");
        if (local)
            workerStore.setEnabled("local", false);
    }
    for (const entry of (0, store_1.parseWorkersEnv)(config.workersBootstrap)) {
        workerStore.upsert({
            id: entry.id,
            baseUrl: entry.baseUrl,
            publicIp: entry.publicIp,
            token: entry.token,
            enabled: true,
            kind: "remote",
        });
    }
    const placement = (0, placement_1.createWorkerPlacement)({
        config,
        store: workerStore,
        localRuntime,
        localPorts,
    });
    const browsers = (0, browser_sessions_1.createBrowserSessionService)({
        config,
        store: browserStore,
        placement,
        preferences,
    });
    const localUsers = (0, local_user_store_1.createLocalUserStore)(db);
    const seeded = await (0, local_user_store_1.seedLocalUsersIfEmpty)(localUsers, config.authUsers, config.bcryptRounds);
    const auth = await (0, local_provider_1.createLocalAuthProvider)(localUsers, config.bcryptRounds);
    const app = await (0, app_1.buildApp)({
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
    const lifecycle = {
        config,
        store: browserStore,
        placement,
        viewers,
    };
    let closing = false;
    let stopReaper = null;
    let stopPoller = null;
    const shutdown = async (signal) => {
        if (closing)
            return;
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
            .catch((error) => {
            console.error(error);
            process.exit(1);
        });
    });
    process.on("SIGTERM", () => {
        void shutdown("SIGTERM")
            .then(() => process.exit(0))
            .catch((error) => {
            console.error(error);
            process.exit(1);
        });
    });
    try {
        if (config.localWorkerEnabled) {
            await localRuntime.ensureNetwork();
        }
        const reconciled = await (0, lifecycle_1.reconcileBrowserSessions)(lifecycle, app.log);
        app.log.info(reconciled, "browser session reconciliation complete");
        const reaper = (0, lifecycle_1.startBrowserReaper)(lifecycle, app.log);
        stopReaper = reaper.stop;
        const poller = (0, scheduler_1.createWorkerPoller)({
            store: workerStore,
            intervalMs: 15_000,
            log: app.log,
            async pollRemote(worker) {
                const client = (0, client_1.createRemoteWorkerClient)({
                    baseUrl: worker.baseUrl,
                    token: worker.token,
                });
                const status = await client.status();
                return { activeSessions: status.activeSessions, publicIp: status.publicIp };
            },
        });
        stopPoller = poller.stop;
        void poller.runOnce();
        await app.listen({ port: config.port, host: config.host });
    }
    catch (error) {
        stopReaper?.();
        stopPoller?.();
        db.close();
        throw error;
    }
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map