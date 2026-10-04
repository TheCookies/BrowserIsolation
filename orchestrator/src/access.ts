import type { AuthenticatedUser } from "./auth/provider";
import type { BrowserSessionRecord } from "./browser-session-store";

export function canAccessBrowserSession(
  user: AuthenticatedUser | null | undefined,
  session: BrowserSessionRecord | null | undefined,
): boolean {
  if (!user || !session) return false;
  if (user.role === "admin") return true;
  return session.ownerUsername === user.username;
}
