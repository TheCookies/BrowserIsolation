import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { policyMountForBrowser } from "../src/config";
import { policyArchiveFromFile, tarSingleFile } from "../src/docker/policy-tar";
import { applyDownloadSecurityPolicy } from "../src/docker/security-policy";

test("policyMountForBrowser uses Neko policy paths", () => {
  assert.equal(policyMountForBrowser("google-chrome")?.dir, "/etc/opt/chrome/policies/managed");
  assert.equal(policyMountForBrowser("brave")?.dir, "/etc/brave/policies/managed");
  assert.equal(policyMountForBrowser("firefox")?.dir, "/usr/lib/firefox/distribution");
  assert.equal(policyMountForBrowser("opera"), null);
});

test("tarSingleFile embeds file content for putArchive", () => {
  const payload = Buffer.from('{"ok":true}\n', "utf8");
  const archive = tarSingleFile("policies.json", payload);
  assert.ok(archive.length >= 512 + payload.length + 1024);
  const name = archive.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
  assert.equal(name, "policies.json");
  assert.equal(archive.subarray(512, 512 + payload.length).toString("utf8"), payload.toString("utf8"));
});

test("repo browser policies omit SponsorBlock", () => {
  const root = path.resolve(__dirname, "../neko-policies");
  const chrome = JSON.parse(readFileSync(path.join(root, "chrome/policies.json"), "utf8")) as {
    ExtensionInstallForcelist: string[];
    ExtensionInstallAllowlist: string[];
  };
  const firefox = JSON.parse(readFileSync(path.join(root, "firefox/policies.json"), "utf8")) as {
    policies: { ExtensionSettings: Record<string, unknown> };
  };
  const brave = JSON.parse(readFileSync(path.join(root, "brave/policies.json"), "utf8")) as {
    ExtensionInstallForcelist: string[];
  };

  assert.ok(
    !chrome.ExtensionInstallForcelist.some((entry) => entry.includes("mnjggcdmjocbbbhaepdhchncahnbgone")),
  );
  assert.ok(!chrome.ExtensionInstallAllowlist.includes("mnjggcdmjocbbbhaepdhchncahnbgone"));
  assert.ok(!("sponsorBlocker@ajay.app" in firefox.policies.ExtensionSettings));
  assert.ok(
    !brave.ExtensionInstallForcelist.some((entry) => entry.includes("mnjggcdmjocbbbhaepdhchncahnbgone")),
  );
  assert.ok("uBlock0@raymondhill.net" in firefox.policies.ExtensionSettings);

  const chromePersist = JSON.parse(
    readFileSync(path.join(root, "chrome/policies.persist.json"), "utf8"),
  ) as { ExtensionInstallForcelist: string[]; DefaultCookiesSetting: number };
  assert.equal(chromePersist.DefaultCookiesSetting, 1);
  assert.ok(
    !chromePersist.ExtensionInstallForcelist.some((entry) =>
      entry.includes("mnjggcdmjocbbbhaepdhchncahnbgone"),
    ),
  );
});

test("policyArchiveFromFile reads disk content", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-policy-"));
  try {
    const file = path.join(dir, "policies.json");
    writeFileSync(file, '{"a":1}\n');
    const archive = policyArchiveFromFile(file);
    assert.ok(archive.includes(Buffer.from('{"a":1}\n')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDownloadSecurityPolicy toggles Chromium download locks", () => {
  const blocked = applyDownloadSecurityPolicy(
    '{"DownloadRestrictions":0,"AllowFileSelectionDialogs":true}\n',
    "chrome",
    false,
  );
  const blockedObj = JSON.parse(blocked) as {
    DownloadRestrictions: number;
    AllowFileSelectionDialogs: boolean;
  };
  assert.equal(blockedObj.DownloadRestrictions, 3);
  assert.equal(blockedObj.AllowFileSelectionDialogs, false);

  const allowed = applyDownloadSecurityPolicy(
    '{"DownloadRestrictions":3,"AllowFileSelectionDialogs":false}\n',
    "brave",
    true,
  );
  const allowedObj = JSON.parse(allowed) as {
    DownloadRestrictions: number;
    AllowFileSelectionDialogs: boolean;
  };
  assert.equal(allowedObj.DownloadRestrictions, 0);
  assert.equal(allowedObj.AllowFileSelectionDialogs, true);

  const firefox = '{"policies":{"PromptForDownloadLocation":false}}\n';
  assert.equal(applyDownloadSecurityPolicy(firefox, "firefox", false), firefox);
});

test("policyArchiveFromFile applies download security overlay", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rbi-policy-"));
  try {
    const file = path.join(dir, "policies.json");
    writeFileSync(file, '{"DownloadRestrictions":0,"AllowFileSelectionDialogs":true}\n');
    const archive = policyArchiveFromFile(file, {
      policySource: "chrome",
      allowDownloads: false,
    });
    assert.ok(archive.includes(Buffer.from('"DownloadRestrictions": 3')));
    assert.ok(archive.includes(Buffer.from('"AllowFileSelectionDialogs": false')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
