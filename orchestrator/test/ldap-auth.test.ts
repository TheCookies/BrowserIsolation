import assert from "node:assert/strict";
import test from "node:test";
import { createCompositeAuthProvider } from "../src/auth/composite-provider";
import { ldapSubjectId } from "../src/auth/identity";
import {
  buildLdapSearchFilter,
  createLdapAuthProvider,
  entryToUser,
  escapeLdapFilterValue,
  formatObjectGuid,
  mapLdapRole,
  type LdapDirectory,
} from "../src/auth/ldap-provider";
import type { AuthProvider } from "../src/auth/provider";
import type { LocalUserStore } from "../src/auth/local-user-store";
import { testConfig } from "./helpers";

test("LDAP filter escapes username and substitutes placeholder", () => {
  const filter = buildLdapSearchFilter(
    "(|(sAMAccountName={{username}})(userPrincipalName={{username}}))",
    'alice)(cn=*',
  );
  assert.match(filter, /sAMAccountName=/);
  assert.doesNotMatch(filter, /\(cn=\*/);
  assert.equal(escapeLdapFilterValue("a*b"), "a\\2ab");
});

test("LDAP admin group matches CN or full DN", () => {
  const groups = [
    "CN=Staff,OU=Groups,DC=example,DC=com",
    "CN=Browser Isolation Admins,OU=Groups,DC=example,DC=com",
  ];
  assert.equal(mapLdapRole(groups, "Browser Isolation Admins"), "admin");
  assert.equal(
    mapLdapRole(groups, "CN=Browser Isolation Admins,OU=Groups,DC=example,DC=com"),
    "admin",
  );
  assert.equal(mapLdapRole(groups, "Other,Staff"), "admin");
  assert.equal(
    mapLdapRole(
      groups,
      "CN=Missing,DC=x;CN=Browser Isolation Admins,OU=Groups,DC=example,DC=com",
    ),
    "admin",
  );
  assert.equal(mapLdapRole(groups, "Portal Admins"), "user");
  assert.equal(mapLdapRole(groups, ""), "user");
});

test("objectGUID and DN become stable ldap subject ids", () => {
  // Little-endian AD GUID bytes for 01020304-0506-0708-090a-0b0c0d0e0f10
  const guid = Buffer.from([
    0x04, 0x03, 0x02, 0x01, 0x06, 0x05, 0x08, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  ]);
  assert.equal(formatObjectGuid(guid), "01020304-0506-0708-090a-0b0c0d0e0f10");
  assert.equal(ldapSubjectId(formatObjectGuid(guid)), "ldap:01020304-0506-0708-090a-0b0c0d0e0f10");

  const user = entryToUser(
    {
      dn: "CN=Alice,OU=Users,DC=example,DC=com",
      attributes: {
        sAMAccountName: "alice",
        memberOf: ["CN=Portal Admins,OU=Groups,DC=example,DC=com"],
        objectGUID: guid,
      },
    },
    "alice",
    {
      ldapUsernameAttr: "",
      ldapGroupsAttr: "",
      ldapAdminGroup: "Portal Admins",
    },
  );
  assert.equal(user.username, "alice");
  assert.equal(user.role, "admin");
  assert.equal(user.subjectId, "ldap:01020304-0506-0708-090a-0b0c0d0e0f10");
});

test("composite auth prefers local users and never falls through to LDAP", async () => {
  const localUsers = {
    get(username: string) {
      return username === "admin" ? ({ username: "admin" } as never) : null;
    },
  } as LocalUserStore;

  const local: AuthProvider = {
    async authenticate(username, password) {
      if (username === "admin" && password === "local-secret") {
        return { username: "admin", role: "admin", subjectId: "local:admin" };
      }
      return null;
    },
  };

  let ldapCalled = false;
  const ldap: AuthProvider = {
    async authenticate() {
      ldapCalled = true;
      return { username: "admin", role: "user", subjectId: "ldap:should-not-happen" };
    },
  };

  const auth = createCompositeAuthProvider({
    localUsers,
    local,
    ldap,
    isLdapEnabled: () => true,
  });

  assert.equal(await auth.authenticate("admin", "wrong"), null);
  assert.equal(ldapCalled, false);

  const ok = await auth.authenticate("admin", "local-secret");
  assert.deepEqual(ok, { username: "admin", role: "admin", subjectId: "local:admin" });
  assert.equal(ldapCalled, false);
});

test("composite auth uses LDAP for unknown usernames when enabled", async () => {
  const localUsers = {
    get() {
      return null;
    },
  } as LocalUserStore;

  const local: AuthProvider = {
    async authenticate() {
      return null;
    },
  };

  const directory: LdapDirectory = {
    async findUser({ username }) {
      if (username !== "alice") return null;
      return {
        dn: "CN=Alice,OU=Users,DC=example,DC=com",
        attributes: {
          sAMAccountName: "alice",
          memberOf: "CN=Users,OU=Groups,DC=example,DC=com",
        },
      };
    },
    async verifyPassword({ password }) {
      return password === "domain-secret";
    },
  };

  const config = testConfig({
    ldapEnabled: true,
    ldapUrl: "ldaps://dc.example.com",
    ldapSearchBase: "DC=example,DC=com",
    ldapAdminGroup: "Portal Admins",
  });

  const auth = createCompositeAuthProvider({
    localUsers,
    local,
    ldap: createLdapAuthProvider(() => config, directory),
    isLdapEnabled: () => config.ldapEnabled,
  });

  assert.equal(await auth.authenticate("alice", "wrong"), null);
  const user = await auth.authenticate("alice", "domain-secret");
  assert.equal(user?.username, "alice");
  assert.equal(user?.role, "user");
  assert.equal(user?.subjectId, "ldap:CN=Alice,OU=Users,DC=example,DC=com");
});
