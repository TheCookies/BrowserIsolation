"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRemoteWorkerClient = createRemoteWorkerClient;
exports.launchSettingsFromConfig = launchSettingsFromConfig;
exports.toCreateInput = toCreateInput;
async function readError(response) {
    try {
        const body = (await response.json());
        if (body.error)
            return body.error;
    }
    catch {
        /* ignore */
    }
    return `worker_http_${response.status}`;
}
function createRemoteWorkerClient(opts) {
    const base = opts.baseUrl.replace(/\/+$/, "");
    async function request(path, init) {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${opts.token}`);
        if (init?.body && !headers.has("content-type")) {
            headers.set("content-type", "application/json");
        }
        return fetch(`${base}${path}`, { ...init, headers });
    }
    return {
        proxyOrigin(containerId) {
            return `${base}/v1/proxy/${encodeURIComponent(containerId)}`;
        },
        async status() {
            const response = await request("/v1/status");
            if (!response.ok)
                throw new Error(await readError(response));
            return (await response.json());
        },
        async host() {
            const response = await request("/v1/host");
            if (!response.ok)
                throw new Error(await readError(response));
            return (await response.json());
        },
        async volumes() {
            const response = await request("/v1/volumes");
            if (!response.ok)
                throw new Error(await readError(response));
            return (await response.json());
        },
        async removeVolume(volumeName) {
            const response = await request(`/v1/volumes/${encodeURIComponent(volumeName)}`, {
                method: "DELETE",
            });
            if (response.status === 404)
                return;
            if (!response.ok)
                throw new Error(await readError(response));
        },
        async createBrowser(input) {
            const response = await request("/v1/browsers", {
                method: "POST",
                body: JSON.stringify(input),
            });
            if (!response.ok)
                throw new Error(await readError(response));
            return (await response.json());
        },
        async inspect(containerId) {
            const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}`);
            if (response.status === 404)
                return null;
            if (!response.ok)
                throw new Error(await readError(response));
            return (await response.json());
        },
        async stats(containerId) {
            const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}/stats`);
            if (!response.ok)
                throw new Error(await readError(response));
            return (await response.json());
        },
        async logs(containerId, tail = 80) {
            const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}/logs?tail=${tail}`);
            if (!response.ok)
                throw new Error(await readError(response));
            const body = (await response.json());
            return body.logs ?? "";
        },
        async remove(containerId) {
            const response = await request(`/v1/browsers/${encodeURIComponent(containerId)}`, {
                method: "DELETE",
            });
            if (response.status === 404)
                return;
            if (!response.ok)
                throw new Error(await readError(response));
        },
        async listManaged() {
            const response = await request("/v1/browsers");
            if (!response.ok)
                throw new Error(await readError(response));
            const body = (await response.json());
            return body.browsers ?? [];
        },
        async pullImages(images) {
            const response = await request("/v1/images/pull", {
                method: "POST",
                body: JSON.stringify({ images }),
            });
            if (!response.ok)
                throw new Error(await readError(response));
            const body = (await response.json());
            return body.results ?? [];
        },
    };
}
function launchSettingsFromConfig(settings) {
    return { ...settings };
}
function toCreateInput(request, webrtcPort) {
    return {
        sessionId: request.sessionId,
        owner: request.owner,
        subjectId: request.subjectId,
        browser: request.browser,
        webrtcPort,
        nekoAdminPassword: request.nekoAdminPassword,
        nekoUserPassword: request.nekoUserPassword,
        persistProfile: request.persistProfile,
        settings: request.settings,
    };
}
//# sourceMappingURL=client.js.map