import type { AuthenticatedUser } from "./auth/provider";
import type { BrowserSessionRecord } from "./browser-session-store";

export function canAccessBrowserSession(
  user: AuthenticatedUser | null | undefined,
  session: BrowserSessionRecord | null | undefined,
): boolean {
  if (!user || !session) return false;
  if (user.role === "admin") return true;
  // Prefer stable subjectId (LDAP/SAML); fall back to display username for safety.
  if (session.ownerSubjectId && user.subjectId) {
    return session.ownerSubjectId === user.subjectId;
  }
  return session.ownerUsername === user.username;
}
