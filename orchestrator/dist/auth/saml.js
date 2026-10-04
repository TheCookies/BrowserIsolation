"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePublicBaseUrl = normalizePublicBaseUrl;
exports.samlServiceUrls = samlServiceUrls;
exports.normalizeIdpCert = normalizeIdpCert;
exports.assertSamlReady = assertSamlReady;
exports.createSamlClient = createSamlClient;
exports.attributeValues = attributeValues;
exports.resolveUsername = resolveUsername;
exports.resolveGroups = resolveGroups;
exports.mapSamlRole = mapSamlRole;
exports.profileToUser = profileToUser;
exports.generateSpMetadata = generateSpMetadata;
const node_saml_1 = require("@node-saml/node-saml");
const identity_1 = require("./identity");
const DEFAULT_EMAIL_ATTRS = [
    "email",
    "mail",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
];
const DEFAULT_GROUP_ATTRS = [
    "groups",
    "group",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
];
function normalizePublicBaseUrl(raw) {
    const value = raw.trim().replace(/\/+$/, "");
    if (!value)
        return "";
    if (!/^https?:\/\//i.test(value)) {
        throw new Error("PUBLIC_BASE_URL must be an absolute http(s) URL.");
    }
    return value;
}
function samlServiceUrls(config) {
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
function normalizeIdpCert(raw) {
    let value = raw.trim().replace(/\\n/g, "\n");
    if (!value)
        throw new Error("SAML_IDP_CERT is required.");
    if (value.includes("BEGIN CERTIFICATE")) {
        return value;
    }
    // Bare base64 → wrap as PEM
    const compact = value.replace(/\s+/g, "");
    const lines = compact.match(/.{1,64}/g) ?? [compact];
    return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}
function assertSamlReady(config) {
    if (!config.samlEnabled)
        return;
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
function createSamlClient(config) {
    assertSamlReady(config);
    const urls = samlServiceUrls(config);
    return new node_saml_1.SAML({
        entryPoint: config.samlEntryPoint.trim(),
        idpCert: normalizeIdpCert(config.samlIdpCert),
        issuer: urls.entityId,
        callbackUrl: urls.acsUrl,
        idpIssuer: config.samlIdpEntityId.trim() || undefined,
        audience: urls.entityId,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: false,
        acceptedClockSkewMs: 120_000,
        validateInResponseTo: node_saml_1.ValidateInResponseTo.never,
        identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    });
}
function asRecord(profile) {
    return profile;
}
function attributeValues(profile, name) {
    if (!name)
        return [];
    const raw = asRecord(profile)[name];
    if (raw === undefined || raw === null)
        return [];
    if (Array.isArray(raw))
        return raw.map((item) => String(item)).filter(Boolean);
    const text = String(raw).trim();
    return text ? [text] : [];
}
function resolveUsername(profile, usernameAttr) {
    if (usernameAttr.trim()) {
        const configured = attributeValues(profile, usernameAttr.trim());
        if (configured[0])
            return configured[0];
    }
    for (const key of DEFAULT_EMAIL_ATTRS) {
        const values = attributeValues(profile, key);
        if (values[0])
            return values[0];
    }
    if (profile.nameID?.trim())
        return profile.nameID.trim();
    throw new Error("SAML assertion did not include a usable username/email.");
}
function resolveGroups(profile, groupsAttr) {
    if (groupsAttr.trim()) {
        return attributeValues(profile, groupsAttr.trim());
    }
    const found = [];
    for (const key of DEFAULT_GROUP_ATTRS) {
        found.push(...attributeValues(profile, key));
    }
    return [...new Set(found)];
}
function mapSamlRole(groups, adminGroup) {
    const needle = adminGroup.trim().toLowerCase();
    if (!needle)
        return "user";
    return groups.some((group) => group.trim().toLowerCase() === needle) ? "admin" : "user";
}
function profileToUser(profile, config) {
    const username = resolveUsername(profile, config.samlUsernameAttr);
    const nameId = profile.nameID?.trim() || username;
    const groups = resolveGroups(profile, config.samlGroupsAttr);
    return {
        username,
        role: mapSamlRole(groups, config.samlAdminGroup),
        subjectId: (0, identity_1.samlSubjectId)(nameId, profile.nameIDFormat || undefined),
    };
}
function generateSpMetadata(config) {
    const client = createSamlClient(config);
    return client.generateServiceProviderMetadata(null);
}
//# sourceMappingURL=saml.js.map