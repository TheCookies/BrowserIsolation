import type { PolicySource } from "../neko-browsers";

/**
 * Overlay admin security toggles onto a managed browser policy JSON document.
 * Chromium-family policies use DownloadRestrictions; Firefox has no equivalent.
 */
export function applyDownloadSecurityPolicy(
  raw: string,
  policySource: PolicySource,
  allowDownloads: boolean,
): string {
  if (!policySource || policySource === "firefox") {
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("browser_policy_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("browser_policy_invalid_json");
  }

  const policy = parsed as Record<string, unknown>;
  // 0 = no special restrictions; 3 = block all downloads (Chrome enterprise policy).
  policy.DownloadRestrictions = allowDownloads ? 0 : 3;
  policy.AllowFileSelectionDialogs = allowDownloads;
  policy.PromptForDownloadLocation = false;
  return `${JSON.stringify(policy, null, 2)}\n`;
}
