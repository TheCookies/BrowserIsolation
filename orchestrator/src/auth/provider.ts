export const ROLES = ["user", "admin"] as const;

export type Role = (typeof ROLES)[number];

export type AuthenticatedUser = {
  /** Display / login label (not used as a storage key). */
  username: string;
  role: Role;
  /**
   * Stable ownership identity for preferences and profile volumes.
   * Local: `local:<username>`. SAML: `saml:<NameID>`. LDAP: `ldap:<objectGUID|DN>`.
   * See docs/USER_IDENTITY.md.
   */
  subjectId: string;
};

/**
 * Portal password authentication. Routes and session logic depend on this
 * interface. Local and LDAP implement it (often via a composite). SAML uses a
 * parallel redirect/ACS path but still emits AuthenticatedUser for sessions.
 */
export interface AuthProvider {
  authenticate(username: string, password: string): Promise<AuthenticatedUser | null>;
}

export function isRole(value: string): value is Role {
  return value === "user" || value === "admin";
}
