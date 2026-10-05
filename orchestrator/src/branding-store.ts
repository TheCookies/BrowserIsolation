import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOGO_BASENAME = "logo";
const MAX_LOGO_BYTES = 1024 * 1024; // 1 MiB

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export type BrandingLogoInfo = {
  /** Public URL path including cache-bust query. */
  url: string;
  contentType: string;
  updatedAt: number;
  filename: string;
};

export type BrandingStore = {
  getLogoInfo(): BrandingLogoInfo | null;
  readLogo(): { buffer: Buffer; contentType: string; updatedAt: number } | null;
  saveLogo(input: { buffer: Buffer; contentType: string; filename?: string }): BrandingLogoInfo;
  removeLogo(): boolean;
};

function brandingDir(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), "branding");
}

function extForContentType(contentType: string): string | null {
  const normalized = contentType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  for (const [ext, type] of Object.entries(CONTENT_TYPES)) {
    if (type === normalized) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  return null;
}

function contentTypeForExt(ext: string): string | null {
  return CONTENT_TYPES[ext.toLowerCase()] ?? null;
}

function findLogoFile(dir: string): { filePath: string; ext: string } | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const match = new RegExp(`^${LOGO_BASENAME}\\.([A-Za-z0-9]+)$`, "i").exec(name);
    if (!match) continue;
    const ext = match[1]!.toLowerCase();
    if (!contentTypeForExt(ext === "jpeg" ? "jpg" : ext) && !contentTypeForExt(ext)) continue;
    return { filePath: path.join(dir, name), ext: ext === "jpeg" ? "jpg" : ext };
  }
  return null;
}

function clearLogoFiles(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (/^logo\./i.test(name)) {
      unlinkSync(path.join(dir, name));
    }
  }
}

export function createBrandingStore(databasePath: string): BrandingStore {
  const dir = brandingDir(databasePath);

  return {
    getLogoInfo() {
      const found = findLogoFile(dir);
      if (!found) return null;
      const contentType = contentTypeForExt(found.ext);
      if (!contentType) return null;
      const updatedAt = Math.floor(statSync(found.filePath).mtimeMs);
      return {
        url: `/branding/logo?v=${updatedAt}`,
        contentType,
        updatedAt,
        filename: path.basename(found.filePath),
      };
    },

    readLogo() {
      const found = findLogoFile(dir);
      if (!found) return null;
      const contentType = contentTypeForExt(found.ext);
      if (!contentType) return null;
      return {
        buffer: readFileSync(found.filePath),
        contentType,
        updatedAt: Math.floor(statSync(found.filePath).mtimeMs),
      };
    },

    saveLogo(input) {
      const ext = extForContentType(input.contentType);
      if (!ext) {
        throw Object.assign(new Error("unsupported_logo_type"), { statusCode: 400 });
      }
      if (!input.buffer.length) {
        throw Object.assign(new Error("empty_logo"), { statusCode: 400 });
      }
      if (input.buffer.length > MAX_LOGO_BYTES) {
        throw Object.assign(new Error("logo_too_large"), { statusCode: 400 });
      }

      mkdirSync(dir, { recursive: true });
      clearLogoFiles(dir);
      const filePath = path.join(dir, `${LOGO_BASENAME}.${ext}`);
      writeFileSync(filePath, input.buffer);
      const updatedAt = Math.floor(statSync(filePath).mtimeMs);
      return {
        url: `/branding/logo?v=${updatedAt}`,
        contentType: CONTENT_TYPES[ext]!,
        updatedAt,
        filename: path.basename(filePath),
      };
    },

    removeLogo() {
      const found = findLogoFile(dir);
      if (!found) return false;
      clearLogoFiles(dir);
      return true;
    },
  };
}

export function decodeLogoDataUrlOrBase64(raw: string): Buffer {
  const trimmed = raw.trim();
  const dataUrl = /^data:([A-Za-z0-9.+/-]+);base64,(.+)$/s.exec(trimmed);
  if (dataUrl) {
    return Buffer.from(dataUrl[2]!, "base64");
  }
  return Buffer.from(trimmed, "base64");
}
