"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const container_runtime_1 = require("./docker/container-runtime");
const labels_1 = require("./docker/labels");
const env_file_1 = require("./env-file");
const app_1 = require("./worker-agent/app");
const memory_port_pool_1 = require("./workers/memory-port-pool");
async function main() {
    const baseDir = node_path_1.default.resolve(__dirname, "../..");
    (0, env_file_1.loadEnvFile)(node_path_1.default.join(baseDir, ".env"));
    const config = (0, config_1.loadConfig)(process.env, baseDir);
    const workerId = process.env.WORKER_ID?.trim() || "worker";
    const token = process.env.WORKER_TOKEN?.trim();
    if (!token) {
        throw new Error("WORKER_TOKEN is required for the worker agent.");
    }
    const port = Number(process.env.WORKER_PORT?.trim() || "8090");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("WORKER_PORT must be an integer from 1 to 65535.");
    }
    const runtime = (0, container_runtime_1.createDockerRuntime)(config);
    await runtime.ensureNetwork();
    const ports = (0, memory_port_pool_1.createMemoryPortPool)(config.webrtcPortStart, config.webrtcPortEnd);
    // Reclaim ports for containers already running on this host.
    for (const container of await runtime.listManaged()) {
        const port = Number(container.labels[labels_1.LABEL_WEBRTC_PORT]);
        if (ports.isInRange(port))
            ports.reserve(port);
    }
    const app = await (0, app_1.buildWorkerAgent)({
        config,
        workerId,
        token,
        runtime,
        ports,
    });
    let closing = false;
    const shutdown = async (signal) => {
        if (closing)
            return;
        closing = true;
        app.log.info({ signal }, "worker shutting down");
        await app.close();
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
    await app.listen({ port, host: config.host });
    app.log.info({
        workerId,
        port,
        publicIp: config.publicIp,
        webrtc: `${config.webrtcPortStart}-${config.webrtcPortEnd}`,
    }, "worker agent listening");
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=worker-main.js.map