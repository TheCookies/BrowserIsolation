export type Role = "user" | "admin";

export type Me = {
  username: string;
  role: Role;
  /** Stable ownership id (local:… today; saml:… later). */
  subjectId: string;
  /** Portal display name from Admin → Settings. */
  siteName: string;
  /** Custom logo URL, or null when using the default mark. */
  logoUrl: string | null;
  persistProfilesEnabled: boolean;
  persistProfile: boolean;
  /** Per-user portal appearance preference. */
  darkMode: boolean;
  /** True for local (password) accounts; false for SAML/SSO users. */
  canChangePassword: boolean;
  csrfToken: string;
};

export type UserPreferences = {
  persistProfilesEnabled: boolean;
  persistProfile: boolean;
  darkMode: boolean;
  subjectId: string;
};

export type BrowserChoice = string;

export type BrowserOption = {
  id: BrowserChoice;
  title: string;
  description: string;
  family: string;
  logo: string;
};

export type AdminBrowserCatalogItem = BrowserOption & {
  image: string;
  enabled: boolean;
};

export type BrowserSession = {
  id: string;
  owner: string;
  browser: BrowserChoice;
  createdAt: string;
  lastActivityAt: string;
  webrtcPort: number;
};

export type SessionAccess = {
  session: BrowserSession;
  wsPath: string;
  username: string;
  password: string;
  iceServers: RTCIceServer[];
  allowClipboard: boolean;
  allowDownloads: boolean;
};

export type AdminBrowserSession = {
  id: string;
  owner: string;
  browser: BrowserChoice;
  workerId: string;
  createdAt: string;
  lastActivityAt: string | null;
  viewers: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
};

export type AdminWorker = {
  id: string;
  baseUrl: string;
  publicIp: string;
  enabled: boolean;
  kind: "local" | "remote";
  online: boolean;
  lastSeenAt: string | null;
  activeSessions: number;
};

export type WorkerHostDisk = {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
};

export type WorkerHostNetworkInterface = {
  name: string;
  state: string | null;
  linkMbps: number | null;
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  utilizationPercent: number | null;
};

export type WorkerHostMetrics = {
  collectedAt: string;
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    model: string | null;
    load1: number;
    load5: number;
    load15: number;
    usagePercent: number | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  disks: WorkerHostDisk[];
  network: {
    sampleMs: number;
    interfaces: WorkerHostNetworkInterface[];
  };
};

export type WorkerStatusDetails = {
  worker: {
    id: string;
    kind: "local" | "remote";
    publicIp: string;
    baseUrl: string;
    enabled: boolean;
    online: boolean;
    activeSessions: number;
  };
  host: WorkerHostMetrics;
};

export type AdminAuditEvent = {
  id: number;
  actor: string;
  action: string;
  sessionId: string;
  owner: string;
  detail: string | null;
  createdAt: string;
};

export type AdminAuditActionDef = {
  id: string;
  label: string;
  category: "admin" | "user";
  description: string;
};

export type AdminAuditQuery = {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  limit?: number;
};

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}, csrfToken?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const data = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!response.ok) {
    const error = new ApiError(response.status, data.error ?? "request_failed");
    if (data.detail) error.message = data.detail;
    throw error;
  }
  return data as T;
}

export async function getMe(): Promise<Me | null> {
  try {
    return await request<Me>("/api/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function login(username: string, password: string): Promise<Me> {
  const csrf = await request<{ csrfToken: string }>("/api/auth/csrf");
  return request<Me>(
    "/api/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ username, password }),
    },
    csrf.csrfToken,
  );
}

export async function logout(csrfToken: string): Promise<void> {
  try {
    await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }, csrfToken);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    throw error;
  }
}

export async function changePassword(
  input: { currentPassword: string; newPassword: string },
  csrfToken: string,
): Promise<{ ok: boolean }> {
  return request(
    "/api/auth/password",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    csrfToken,
  );
}

export type AdminAbout = {
  name: string;
  siteName: string;
  version: string;
  gitSha: string;
  gitShaShort: string;
  gitCommitTime: string;
  builtAt: string;
  image: string;
  repository: string;
  commitUrl: string | null;
  node: string;
  platform: string;
  role: string;
  publicIp: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  profileDataDir: string;
  persistProfilesEnabled: boolean;
  localWorkerEnabled: boolean;
  browserNetworkMode: string;
  webrtcPortRange: string;
  enabledBrowsers: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
};

export function getAdminAbout(): Promise<AdminAbout> {
  return request("/api/admin/about");
}

export function getAdminSessions(): Promise<{ sessions: AdminBrowserSession[] }> {
  return request("/api/admin/sessions");
}

export function getAdminWorkers(): Promise<{ workers: AdminWorker[] }> {
  return request("/api/admin/workers");
}

export function createAdminWorker(
  body: { id: string; baseUrl: string; publicIp: string; token: string },
  csrfToken: string,
): Promise<{ ok: boolean; worker: AdminWorker }> {
  return request(
    "/api/admin/workers",
    { method: "POST", body: JSON.stringify(body) },
    csrfToken,
  );
}

export function setAdminWorkerEnabled(
  workerId: string,
  enabled: boolean,
  csrfToken: string,
): Promise<{
  ok: boolean;
  worker: AdminWorker;
  probeError?: string | null;
  pullingImages?: boolean;
  pullImageCount?: number;
}> {
  return request(
    `/api/admin/workers/${encodeURIComponent(workerId)}`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
    csrfToken,
  );
}

export function deleteAdminWorker(
  workerId: string,
  csrfToken: string,
): Promise<{ ok: boolean }> {
  return request(`/api/admin/workers/${encodeURIComponent(workerId)}`, { method: "DELETE" }, csrfToken);
}

export function getAdminWorkerStatus(workerId: string): Promise<WorkerStatusDetails> {
  return request(`/api/admin/workers/${encodeURIComponent(workerId)}/status`);
}

export type AdminProfileVolume = {
  volumeName: string;
  subjectKey: string | null;
  subjectId: string | null;
  username: string | null;
  browser: string | null;
  workerId: string;
  sizeBytes: number | null;
  persistProfileEnabled: boolean | null;
  createdAt: string | null;
  mountpoint: string | null;
};

export type AdminProfileUsageByUser = {
  subjectKey: string;
  subjectId: string | null;
  username: string | null;
  volumeCount: number;
  sizeBytes: number;
};

export function getAdminProfileVolumes(): Promise<{
  volumes: AdminProfileVolume[];
  totalBytes: number;
  errors: Array<{ workerId: string; error: string }>;
  byUser: AdminProfileUsageByUser[];
}> {
  return request("/api/admin/profile-volumes");
}

export function deleteAdminProfileVolume(
  body: { workerId: string; volumeName: string },
  csrfToken: string,
): Promise<{ ok: boolean }> {
  return request(
    "/api/admin/profile-volumes",
    { method: "DELETE", body: JSON.stringify(body) },
    csrfToken,
  );
}

export function getAdminAudit(query: AdminAuditQuery = {}): Promise<{
  events: AdminAuditEvent[];
  catalog: AdminAuditActionDef[];
  enabledActions: string[];
}> {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.actor) params.set("actor", query.actor);
  if (query.action) params.set("action", query.action);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return request(`/api/admin/audit${qs ? `?${qs}` : ""}`);
}

export function joinAdminSession(sessionId: string, csrfToken: string): Promise<SessionAccess> {
  return request(`/api/admin/sessions/${sessionId}/join`, { method: "POST" }, csrfToken);
}

export function terminateAdminSession(
  sessionId: string,
  csrfToken: string,
): Promise<{ ok: boolean; destroyed: boolean }> {
  return request(`/api/admin/sessions/${sessionId}`, { method: "DELETE" }, csrfToken);
}

export type AdminSettingField = {
  key: string;
  label: string;
  description: string;
  group: "portal" | "security" | "browser" | "webrtc" | "cleanup" | "sso" | "audit";
  type: "string" | "boolean" | "number" | "select" | "json" | "size" | "text";
  options?: string[];
  min?: number;
  max?: number;
  appliesToNewSessions?: boolean;
  value: string;
  overridden: boolean;
};

export type AuthMethods = {
  local: boolean;
  saml: boolean;
  siteName: string;
  logoUrl: string | null;
  ssoLabel?: string;
  samlUrls?: {
    entityId: string | null;
    metadataUrl: string | null;
    acsUrl: string | null;
    baseUrl: string | null;
  } | null;
};

export function getAuthMethods(): Promise<AuthMethods> {
  return request("/api/auth/methods");
}

export type AdminReadonlySetting = {
  key: string;
  label: string;
  description: string;
  value: string;
};

export type AdminSettings = {
  editable: AdminSettingField[];
  readonly: AdminReadonlySetting[];
};

export function getAdminSettings(): Promise<AdminSettings> {
  return request("/api/admin/settings");
}

export function updateAdminSettings(
  settings: Record<string, string>,
  csrfToken: string,
): Promise<AdminSettings & { ok: boolean; updated: string[] }> {
  return request(
    "/api/admin/settings",
    {
      method: "PUT",
      body: JSON.stringify({ settings }),
    },
    csrfToken,
  );
}

export type BrandingLogo = {
  url: string;
  contentType: string;
  updatedAt: number;
  filename: string;
};

export function getAdminBranding(): Promise<{ logo: BrandingLogo | null }> {
  return request("/api/admin/branding");
}

export function uploadAdminLogo(
  input: { contentType: string; data: string; filename?: string },
  csrfToken: string,
): Promise<{ ok: boolean; logo: BrandingLogo }> {
  return request(
    "/api/admin/branding/logo",
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
    csrfToken,
  );
}

export function deleteAdminLogo(csrfToken: string): Promise<{ ok: boolean; removed: boolean }> {
  return request("/api/admin/branding/logo", { method: "DELETE" }, csrfToken);
}

export type AdminLocalUser = {
  username: string;
  role: Role;
  subjectId: string;
  createdAt: string;
  updatedAt: string;
};

export function getBrowsers(): Promise<{ browsers: BrowserOption[] }> {
  return request("/api/browsers");
}

export function getAdminBrowsers(): Promise<{
  tag: string;
  browsers: AdminBrowserCatalogItem[];
}> {
  return request("/api/admin/browsers");
}

export type AdminBrowserImageResult = {
  image: string;
  ok: boolean;
  missing?: boolean;
  error?: string;
  workerId?: string;
};

export type UpdateAdminBrowsersResult = {
  ok: boolean;
  tag: string;
  browsers: AdminBrowserCatalogItem[];
  added: string[];
  removed: string[];
  pullImages: string[];
  removedImages: AdminBrowserImageResult[];
};

export function updateAdminBrowsers(
  enabled: string[],
  csrfToken: string,
): Promise<UpdateAdminBrowsersResult> {
  return request(
    "/api/admin/browsers",
    {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    },
    csrfToken,
  );
}

export function pullAdminBrowsers(csrfToken: string): Promise<{
  ok: boolean;
  tag: string;
  results: Array<{ image: string; ok: boolean; error?: string }>;
}> {
  return request("/api/admin/browsers/pull", { method: "POST" }, csrfToken);
}

export type BrowserPullStreamEvent =
  | {
      type: "start";
      tag: string;
      images: string[];
      message: string;
    }
  | {
      type: "progress";
      image: string;
      status: string;
      id?: string;
      current?: number;
      total?: number;
      percent?: number;
      detail?: string;
    }
  | {
      type: "done";
      ok: boolean;
      tag: string;
      results: Array<{ image: string; ok: boolean; error?: string; workerId?: string }>;
      message: string;
    }
  | { type: "error"; message: string };

export async function pullAdminBrowsersStream(
  csrfToken: string,
  onEvent: (event: BrowserPullStreamEvent) => void,
  signal?: AbortSignal,
  images?: string[],
): Promise<void> {
  const response = await fetch("/api/admin/browsers/pull/stream", {
    method: "POST",
    headers: {
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(images && images.length > 0 ? { images } : {}),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
    const error = new ApiError(response.status, data.error ?? "request_failed");
    if (data.detail) error.message = data.detail;
    throw error;
  }
  if (!response.body) {
    throw new ApiError(500, "stream_unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as BrowserPullStreamEvent);
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
}

export function getAdminUsers(): Promise<{ users: AdminLocalUser[] }> {
  return request("/api/admin/users");
}

export function createAdminUser(
  input: { username: string; password: string; role: Role },
  csrfToken: string,
): Promise<{ user: AdminLocalUser }> {
  return request(
    "/api/admin/users",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    csrfToken,
  );
}

export function updateAdminUser(
  username: string,
  patch: { role?: Role; password?: string },
  csrfToken: string,
): Promise<{ user: AdminLocalUser }> {
  return request(
    `/api/admin/users/${encodeURIComponent(username)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
    csrfToken,
  );
}

export function deleteAdminUser(
  username: string,
  csrfToken: string,
): Promise<{ ok: boolean }> {
  return request(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" }, csrfToken);
}

export async function getMySession(): Promise<BrowserSession | null> {
  const result = await request<{ session: BrowserSession | null }>("/api/sessions/mine");
  return result.session;
}

export function launchSession(
  browser: BrowserChoice,
  csrfToken: string,
): Promise<{ session: BrowserSession; reconnect: boolean }> {
  return request(
    "/api/sessions",
    {
      method: "POST",
      body: JSON.stringify({ browser }),
    },
    csrfToken,
  );
}

export function getSessionAccess(sessionId: string, csrfToken: string): Promise<SessionAccess> {
  return request(`/api/sessions/${sessionId}/access`, { method: "POST" }, csrfToken);
}

export function destroyMySession(csrfToken: string): Promise<{ ok: boolean; destroyed: boolean }> {
  return request("/api/sessions/mine", { method: "DELETE" }, csrfToken);
}

export function getPreferences(): Promise<UserPreferences> {
  return request("/api/preferences");
}

export function updatePreferences(
  patch: { persistProfile?: boolean; darkMode?: boolean },
  csrfToken: string,
): Promise<UserPreferences> {
  return request(
    "/api/preferences",
    {
      method: "PUT",
      body: JSON.stringify(patch),
    },
    csrfToken,
  );
}

export function setPersistProfile(
  persistProfile: boolean,
  csrfToken: string,
): Promise<UserPreferences> {
  return updatePreferences({ persistProfile }, csrfToken);
}

export function setDarkMode(darkMode: boolean, csrfToken: string): Promise<UserPreferences> {
  return updatePreferences({ darkMode }, csrfToken);
}
