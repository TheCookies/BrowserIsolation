"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyDownloadSecurityPolicy = applyDownloadSecurityPolicy;
/**
 * Overlay admin security toggles onto a managed browser policy JSON document.
 * Chromium-family policies use DownloadRestrictions; Firefox has no equivalent.
 */
function applyDownloadSecurityPolicy(raw, policySource, allowDownloads) {
    if (!policySource || policySource === "firefox") {
        return raw;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("browser_policy_invalid_json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("browser_policy_invalid_json");
    }
    const policy = parsed;
    // 0 = no special restrictions; 3 = block all downloads (Chrome enterprise policy).
    policy.DownloadRestrictions = allowDownloads ? 0 : 3;
    policy.AllowFileSelectionDialogs = allowDownloads;
    policy.PromptForDownloadLocation = false;
    return `${JSON.stringify(policy, null, 2)}\n`;
}
//# sourceMappingURL=security-policy.js.map