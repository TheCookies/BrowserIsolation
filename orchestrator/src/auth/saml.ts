import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { Profile } from "@node-saml/node-saml";
import type { Config } from "../config";
import type { AuthenticatedUser, Role } from "./provider";
import { samlSubjectId } from "./identity";

const DEFAULT_EMAIL_ATTRS = [
  "email",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
] as const;

const DEFAULT_GROUP_ATTRS = [
  "groups",
  "group",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
] as const;

export type SamlServiceUrls = {
  baseUrl: string;
  acsUrl: string;
  metadataUrl: string;
  entityId: string;
};

export function normalizePublicBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("PUBLIC_BASE_URL must be an absolute http(s) URL.");
  }
  return value;
}

export function samlServiceUrls(config: Config): SamlServiceUrls {
  const baseUrl = normalizePublicBaseUrl(config.publicBaseUrl);
  if (!baseUrl) {
    throw new Error("PUBLIC_BASE_URL is required for SAML.");
  }
  const metadataUrl = `${baseUrl}/saml/metadata`;
  return {
    baseUrl,
    acsUrl: `${baseUrl}/api/auth/saml/acs`,
    metadataUrl,
    entityId: config.samlSpEntityId.trim() || metadataUrl,
  };
}

export function normalizeIdpCert(raw: string): string {
  let value = raw.trim().replace(/\\n/g, "\n");
  if (!value) throw new Error("SAML_IDP_CERT is required.");
  if (value.includes("BEGIN CERTIFICATE")) {
    return value;
  }
  // Bare base64 → wrap as PEM
  const compact = value.replace(/\s+/g, "");
  const lines = compact.match(/.{1,64}/g) ?? [compact];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

export function assertSamlReady(config: Config): void {
  if (!config.samlEnabled) return;
  normalizePublicBaseUrl(config.publicBaseUrl || "");
  if (!config.publicBaseUrl.trim()) {
    throw new Error("PUBLIC_BASE_URL is required when SAML is enabled.");
  }
  if (!config.samlEntryPoint.trim()) {
    throw new Error("SAML_ENTRY_POINT is required when SAML is enabled.");
  }
  if (!/^https?:\/\//i.test(config.samlEntryPoint.trim())) {
    throw new Error("SAML_ENTRY_POINT must be an absolute http(s) URL.");
  }
  normalizeIdpCert(config.samlIdpCert);
}

export function createSamlClient(config: Config): SAML {
  assertSamlReady(config);
  const urls = samlServiceUrls(config);
  return new SAML({
    entryPoint: config.samlEntryPoint.trim(),
    idpCert: normalizeIdpCert(config.samlIdpCert),
    issuer: urls.entityId,
    callbackUrl: urls.acsUrl,
    idpIssuer: config.samlIdpEntityId.trim() || undefined,
    audience: urls.entityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 120_000,
    validateInResponseTo: ValidateInResponseTo.never,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });
}

function asRecord(profile: Profile): Record<string, unknown> {
  return profile as unknown as Record<string, unknown>;
}

export function attributeValues(profile: Profile, name: string): string[] {
  if (!name) return [];
  const raw = asRecord(profile)[name];
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  const text = String(raw).trim();
  return text ? [text] : [];
}

export function resolveUsername(profile: Profile, usernameAttr: string): string {
  if (usernameAttr.trim()) {
    const configured = attributeValues(profile, usernameAttr.trim());
    if (configured[0]) return configured[0];
  }
  for (const key of DEFAULT_EMAIL_ATTRS) {
    const values = attributeValues(profile, key);
    if (values[0]) return values[0];
  }
  if (profile.nameID?.trim()) return profile.nameID.trim();
  throw new Error("SAML assertion did not include a usable username/email.");
}

export function resolveGroups(profile: Profile, groupsAttr: string): string[] {
  if (groupsAttr.trim()) {
    return attributeValues(profile, groupsAttr.trim());
  }
  const found: string[] = [];
  for (const key of DEFAULT_GROUP_ATTRS) {
    found.push(...attributeValues(profile, key));
  }
  return [...new Set(found)];
}

export function mapSamlRole(groups: string[], adminGroup: string): Role {
  const needle = adminGroup.trim().toLowerCase();
  if (!needle) return "user";
  return groups.some((group) => group.trim().toLowerCase() === needle) ? "admin" : "user";
}

export function profileToUser(profile: Profile, config: Config): AuthenticatedUser {
  const username = resolveUsername(profile, config.samlUsernameAttr);
  const nameId = profile.nameID?.trim() || username;
  const groups = resolveGroups(profile, config.samlGroupsAttr);
  return {
    username,
    role: mapSamlRole(groups, config.samlAdminGroup),
    subjectId: samlSubjectId(nameId, profile.nameIDFormat || undefined),
  };
}

export function generateSpMetadata(config: Config): string {
  const client = createSamlClient(config);
  return client.generateServiceProviderMetadata(null);
}
