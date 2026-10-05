import type Database from "better-sqlite3";

export type AuditActionCategory = "admin" | "user";

/** Every action that can appear in the audit log. */
export const AUDIT_ACTIONS = [
  "join",
  "terminate",
  "update_settings",
  "create_user",
  "update_user_role",
  "reset_user_password",
  "change_password",
  "delete_user",
  "create_worker",
  "enable_worker",
  "disable_worker",
  "delete_worker",
  "delete_volume",
  "update_browsers",
  "pull_browsers",
  "login",
  "saml_login",
  "logout",
  "create_session",
  "destroy_session",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActionDef = {
  id: AuditAction;
  label: string;
  category: AuditActionCategory;
  description: string;
};

/** Labels and groups for Settings → Audit configure + Audit log filters. */
export const AUDIT_ACTION_DEFS: AuditActionDef[] = [
  {
    id: "join",
    label: "Join session",
    category: "admin",
    description: "Administrator joins a user browser session.",
  },
  {
    id: "terminate",
    label: "Terminate session",
    category: "admin",
    description: "Administrator deletes / terminates a browser session.",
  },
  {
    id: "update_settings",
    label: "Change settings",
    category: "admin",
    description: "Administrator changes portal settings.",
  },
  {
    id: "create_worker",
    label: "Create worker",
    category: "admin",
    description: "Administrator registers a worker node.",
  },
  {
    id: "enable_worker",
    label: "Enable worker",
    category: "admin",
    description: "Administrator enables a worker.",
  },
  {
    id: "disable_worker",
    label: "Disable worker",
    category: "admin",
    description: "Administrator disables a worker.",
  },
  {
    id: "delete_worker",
    label: "Delete worker",
    category: "admin",
    description: "Administrator removes a worker.",
  },
  {
    id: "delete_volume",
    label: "Delete persistent volume",
    category: "admin",
    description: "Administrator deletes a persistent profile volume.",
  },
  {
    id: "update_browsers",
    label: "Update browsers",
    category: "admin",
    description: "Administrator changes which browsers are enabled.",
  },
  {
    id: "pull_browsers",
    label: "Pull browser images",
    category: "admin",
    description: "Administrator pulls latest browser images.",
  },
  {
    id: "create_user",
    label: "Create user",
    category: "user",
    description: "Administrator creates a local user account.",
  },
  {
    id: "update_user_role",
    label: "Change user role",
    category: "user",
    description: "Administrator changes a user’s role.",
  },
  {
    id: "reset_user_password",
    label: "Reset user password",
    category: "user",
    description: "Administrator resets a user’s password.",
  },
  {
    id: "change_password",
    label: "Change password",
    category: "user",
    description: "Local user changes their own password.",
  },
  {
    id: "delete_user",
    label: "Delete user",
    category: "user",
    description: "Administrator deletes a local user account.",
  },
  {
    id: "login",
    label: "Login (password)",
    category: "user",
    description: "User signs in with username and password.",
  },
  {
    id: "saml_login",
    label: "Login (SSO)",
    category: "user",
    description: "User signs in via SAML SSO.",
  },
  {
    id: "logout",
    label: "Logout",
    category: "user",
    description: "User signs out of the portal.",
  },
  {
    id: "create_session",
    label: "Create browser",
    category: "user",
    description: "User launches an isolated browser session.",
  },
  {
    id: "destroy_session",
    label: "End browser",
    category: "user",
    description: "User ends their isolated browser session.",
  },
];

const ACTION_SET = new Set<string>(AUDIT_ACTIONS);

export function isAuditAction(value: string): value is AuditAction {
  return ACTION_SET.has(value);
}

/** Default: log everything. */
export function defaultAuditEnabledActions(): AuditAction[] {
  return [...AUDIT_ACTIONS];
}

/**
 * Parse stored JSON array of enabled audit actions.
 * Blank / missing → all actions enabled. Unknown ids are dropped.
 */
export function parseAuditEnabledActions(raw: string | undefined | null): AuditAction[] {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return defaultAuditEnabledActions();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AUDIT_ENABLED_ACTIONS must be a JSON array of action ids.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("AUDIT_ENABLED_ACTIONS must be a JSON array of action ids.");
  }
  const enabled: AuditAction[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string" || !isAuditAction(item) || seen.has(item)) continue;
    seen.add(item);
    enabled.push(item);
  }
  return enabled;
}

export function formatAuditEnabledActions(actions: readonly string[]): string {
  const enabled = parseAuditEnabledActions(JSON.stringify(actions));
  return JSON.stringify(enabled);
}

export type AuditEvent = {
  id: number;
  actorUsername: string;
  action: AuditAction;
  sessionId: string;
  ownerUsername: string;
  detail: string | null;
  createdAt: number;
};

export type AuditListFilter = {
  limit?: number;
  /** Inclusive lower bound (epoch ms). */
  from?: number;
  /** Inclusive upper bound (epoch ms). */
  to?: number;
  /** Case-insensitive substring match on actor username. */
  actor?: string;
  /** Exact action id. */
  action?: AuditAction;
};

type Row = {
  id: number;
  actor_username: string;
  action: string;
  session_id: string;
  owner_username: string;
  detail: string | null;
  created_at: number;
};

function mapRow(row: Row): AuditEvent {
  return {
    id: row.id,
    actorUsername: row.actor_username,
    action: row.action as AuditAction,
    sessionId: row.session_id,
    ownerUsername: row.owner_username,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export type AuditStore = {
  record(input: {
    actorUsername: string;
    action: AuditAction;
    sessionId?: string;
    ownerUsername?: string;
    detail?: string | null;
    at?: number;
  }): AuditEvent | null;
  list(filter?: AuditListFilter | number): AuditEvent[];
};

export type AuditStoreOptions = {
  /** When false, the event is not persisted. Defaults to always enabled. */
  isEnabled?: (action: AuditAction) => boolean;
};

export function createAuditStore(db: Database.Database, options: AuditStoreOptions = {}): AuditStore {
  const isEnabled = options.isEnabled ?? (() => true);
  const insert = db.prepare(`
    INSERT INTO audit_events (
      actor_username, action, session_id, owner_username, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  return {
    record(input) {
      if (!isEnabled(input.action)) return null;
      const at = input.at ?? Date.now();
      const sessionId = input.sessionId ?? "";
      const ownerUsername = input.ownerUsername ?? "";
      const result = insert.run(
        input.actorUsername,
        input.action,
        sessionId,
        ownerUsername,
        input.detail ?? null,
        at,
      );
      return {
        id: Number(result.lastInsertRowid),
        actorUsername: input.actorUsername,
        action: input.action,
        sessionId,
        ownerUsername,
        detail: input.detail ?? null,
        createdAt: at,
      };
    },

    list(filterOrLimit = {}) {
      const filter: AuditListFilter =
        typeof filterOrLimit === "number" ? { limit: filterOrLimit } : filterOrLimit;
      const capped = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 200)));
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (filter.from !== undefined && Number.isFinite(filter.from)) {
        clauses.push("created_at >= ?");
        params.push(Math.floor(filter.from));
      }
      if (filter.to !== undefined && Number.isFinite(filter.to)) {
        clauses.push("created_at <= ?");
        params.push(Math.floor(filter.to));
      }
      if (filter.actor?.trim()) {
        clauses.push("LOWER(actor_username) LIKE ?");
        params.push(`%${filter.actor.trim().toLowerCase()}%`);
      }
      if (filter.action && isAuditAction(filter.action)) {
        clauses.push("action = ?");
        params.push(filter.action);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const stmt = db.prepare<unknown[], Row>(
        `SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`,
      );
      params.push(capped);
      return stmt.all(...params).map(mapRow);
    },
  };
}
