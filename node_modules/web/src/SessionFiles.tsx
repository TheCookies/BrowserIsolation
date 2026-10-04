import { useRef, useState } from "react";
import type { SessionAccess } from "./api";

type FileItem = { name: string; size: number };

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

function authQuery(access: SessionAccess): string {
  return new URLSearchParams({
    usr: access.username,
    pwd: access.password,
  }).toString();
}

function downloadUrl(access: SessionAccess, filename: string): string {
  const params = new URLSearchParams({
    usr: access.username,
    pwd: access.password,
    filename,
  });
  return `/session/${access.session.id}/view/file?${params.toString()}`;
}

export function SessionFiles({
  access,
  files,
  open,
  onClose,
  onRefresh,
}: {
  access: SessionAccess;
  files: FileItem[];
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function upload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      for (const file of Array.from(fileList)) {
        body.append("files", file, file.name);
      }
      const response = await fetch(`/session/${access.session.id}/view/file?${authQuery(access)}`, {
        method: "POST",
        body,
      });
      if (!response.ok) {
        throw new Error(`upload_failed_${response.status}`);
      }
      onRefresh();
    } catch {
      setError("Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <aside className="session-files" aria-label="Session files">
      <div className="session-files-head">
        <h2>Files</h2>
        <button type="button" className="button-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint session-files-hint">
        Transfer files between your machine and the isolated browser Downloads folder.
      </p>
      <div className="session-files-actions">
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        <button type="button" className="button-quiet" disabled={busy} onClick={onRefresh}>
          Refresh
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => void upload(event.target.files)}
        />
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {files.length === 0 ? (
        <p className="hint">No files in Downloads yet.</p>
      ) : (
        <ul className="session-files-list">
          {files.map((file) => (
            <li key={file.name}>
              <a href={downloadUrl(access, file.name)} download={file.name}>
                {file.name}
              </a>
              <span>{formatBytes(file.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
