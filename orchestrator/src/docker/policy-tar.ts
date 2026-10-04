import { readFileSync } from "node:fs";
import type { PolicySource } from "../neko-browsers";
import { applyDownloadSecurityPolicy } from "./security-policy";

/** Build a minimal ustar archive containing a single file (for docker putArchive). */
export function tarSingleFile(fileName: string, content: Buffer): Buffer {
  const name = fileName.replace(/^\.?\//, "").slice(0, 100);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "utf8");
  header.write("0000000\0", 108, "utf8");
  header.write("0000000\0", 116, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "utf8");
  header.write("        ", 148, "utf8");
  header.write("0", 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");

  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i]!;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");

  const padding = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(padding), Buffer.alloc(1024)]);
}

export function policyArchiveFromFile(
  policyFilePath: string,
  options?: { policySource?: PolicySource; allowDownloads?: boolean },
): Buffer {
  let content = readFileSync(policyFilePath);
  if (options?.policySource) {
    const next = applyDownloadSecurityPolicy(
      content.toString("utf8"),
      options.policySource,
      options.allowDownloads ?? false,
    );
    content = Buffer.from(next, "utf8");
  }
  return tarSingleFile("policies.json", content);
}
