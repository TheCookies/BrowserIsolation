export const ROLES = ["user", "admin"] as const;

export type Role = (typeof ROLES)[number];

export type AuthenticatedUser = {
  /** Display / login label (not used as a storage key). */
  username: string;
  role: Role;
  /**
   * Stable ownership identity for preferences and profile volumes.
   * Local: `local:<username>`. SAML: `saml:<NameID>` (see docs/USER_IDENTITY.md).
   */
  subjectId: string;
};

/**
 * Portal authentication. Routes and session logic depend on this interface,
 * not on a particular provider. A SAML implementation can replace the local one
 * without changing callers — return the same AuthenticatedUser shape with a
 * SAML-derived subjectId.
 */
export interface AuthProvider {
  authenticate(username: string, password: string): Promise<AuthenticatedUser | null>;
}

export function isRole(value: string): value is Role {
  return value === "user" || value === "admin";
}
