import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ldapSubjectId,
  localSubjectId,
  parseProfileVolumeName,
  profileStorageKey,
  profileVolumeName,
  samlSubjectId,
} from "../src/auth/identity";
import { profileHostDir } from "../src/docker/profile-paths";

test("local, saml, and ldap subject ids use stable prefixes", () => {
  assert.equal(localSubjectId("alice"), "local:alice");
  assert.equal(samlSubjectId("alice@example.com"), "saml:alice@example.com");
  assert.equal(
    samlSubjectId("alice@example.com", "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
    "saml:urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress:alice@example.com",
  );
  assert.equal(ldapSubjectId("01020304-0506-0708-090a-0b0c0d0e0f10"), "ldap:01020304-0506-0708-090a-0b0c0d0e0f10");
  assert.notEqual(
    profileStorageKey(localSubjectId("alice")),
    profileStorageKey(ldapSubjectId("alice")),
  );
});

test("profile volume names are path-safe and per-browser", () => {
  const subject = localSubjectId("alice");
  const key = profileStorageKey(subject);
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(profileVolumeName(subject, "google-chrome"), `rbi-profile-${key}-google-chrome`);
  assert.notEqual(profileStorageKey(subject), profileStorageKey(samlSubjectId("alice")));
  assert.deepEqual(parseProfileVolumeName(`rbi-profile-${key}-google-chrome`), {
    subjectKey: key,
    browser: "google-chrome",
  });
  assert.equal(parseProfileVolumeName("rbi-data"), null);
});

test("persistent profiles live under PROFILE_DATA_DIR on the host", () => {
  const subject = localSubjectId("alice");
  const key = profileStorageKey(subject);
  assert.equal(
    profileHostDir("/var/lib/browser-isolation/profiles", subject, "google-chrome"),
    path.join("/var/lib/browser-isolation/profiles", key, "google-chrome"),
  );
});
