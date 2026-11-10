import type { LocalUserStore } from "./local-user-store";
import type { AuthProvider, AuthenticatedUser } from "./provider";

/**
 * Local-first password auth: if the username exists in `local_users`, only the
 * local provider is tried (preserves break-glass admins and avoids dual
 * identities). Otherwise, when LDAP is enabled, try the LDAP provider.
 */
export function createCompositeAuthProvider(options: {
  localUsers: LocalUserStore;
  local: AuthProvider;
  ldap: AuthProvider;
  isLdapEnabled: () => boolean;
}): AuthProvider {
  const { localUsers, local, ldap, isLdapEnabled } = options;
  return {
    async authenticate(username, password): Promise<AuthenticatedUser | null> {
      const login = username.trim();
      if (!login) return null;
      if (localUsers.get(login)) {
        return local.authenticate(login, password);
      }
      if (!isLdapEnabled()) return null;
      return ldap.authenticate(login, password);
    },
  };
}
