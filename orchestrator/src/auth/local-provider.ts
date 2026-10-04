import bcrypt from "bcrypt";
import type { LocalUserStore } from "./local-user-store";
import { isRole, type AuthProvider, type AuthenticatedUser, type Role } from "./provider";

const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

export type ParsedAuthUser = {
  username: string;
  password: string;
  role: Role;
};

export function parseAuthUsers(spec: string): ParsedAuthUser[] {
  const entries = spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error("AUTH_USERS is empty. See .env.example.");
  }

  const users: ParsedAuthUser[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length < 3) {
      throw new Error("AUTH_USERS entries must look like username:password:role.");
    }
    const username = parts[0]?.trim() ?? "";
    const roleText = parts[parts.length - 1]?.trim() ?? "";
    const password = parts.slice(1, -1).join(":").trim();
    if (!USERNAME.test(username)) {
      throw new Error(`AUTH_USERS username "${username}" is not allowed.`);
    }
    if (!password) {
      throw new Error(`AUTH_USERS password for "${username}" is empty.`);
    }
    if (!isRole(roleText)) {
      throw new Error(`AUTH_USERS role for "${username}" must be user or admin.`);
    }
    if (seen.has(username)) {
      throw new Error(`AUTH_USERS lists "${username}" more than once.`);
    }
    seen.add(username);
    users.push({ username, password, role: roleText });
  }
  return users;
}

export async function hashAuthUsers(
  spec: string,
  rounds: number,
): Promise<Map<string, { role: Role; passwordHash: string }>> {
  const parsed = parseAuthUsers(spec);
  const records = new Map<string, { role: Role; passwordHash: string }>();
  for (const user of parsed) {
    records.set(user.username, {
      role: user.role,
      passwordHash: await bcrypt.hash(user.password, rounds),
    });
  }
  return records;
}

/** DB-backed local auth used by the portal (see docs/USER_IDENTITY.md). */
export async function createLocalAuthProvider(
  users: LocalUserStore,
  rounds = 12,
): Promise<AuthProvider> {
  const dummyHash = await bcrypt.hash("local-auth-dummy-password", rounds);

  return {
    async authenticate(username: string, password: string): Promise<AuthenticatedUser | null> {
      const record = users.getAuthRecord(username);
      const hash = record?.passwordHash ?? dummyHash;
      const matches = await bcrypt.compare(password, hash);
      if (!record || !matches) return null;
      return {
        username,
        role: record.role,
        subjectId: record.subjectId,
      };
    },
  };
}
