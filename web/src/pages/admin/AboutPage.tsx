import { useEffect, useState, type ReactNode } from "react";
import { getAdminAbout, type AdminAbout } from "../../api";
import { formatTime } from "./format";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="about-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function AboutPage() {
  const [info, setInfo] = useState<AdminAbout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminAbout()
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load build information.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="card wide">
      <div className="panel-header">
        <div>
          <h1>About</h1>
          <p className="hint">Build identity for this portal. The version is set when the image is published from main.</p>
        </div>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {info ? (
        <>
          <div className="about-version">
            <p className="eyebrow">Version</p>
            <p className="about-version-value">{info.version}</p>
            {info.gitShaShort !== "unknown" ? (
              <p className="hint">
                Commit {info.gitShaShort}
                {info.commitUrl ? (
                  <>
                    {" "}
                    ·{" "}
                    <a href={info.commitUrl} target="_blank" rel="noreferrer">
                      view on GitHub
                    </a>
                  </>
                ) : null}
              </p>
            ) : (
              <p className="hint">Local or unpublished build (no image version baked in).</p>
            )}
          </div>

          <h2 className="admin-subhead">Build</h2>
          <dl className="about-list">
            <Row label="Git commit">{info.gitSha}</Row>
            <Row label="Committed">{formatTime(info.gitCommitTime || null)}</Row>
            <Row label="Image built">{formatTime(info.builtAt || null)}</Row>
            <Row label="Image">{info.image}</Row>
            <Row label="Repository">
              <a href={info.repository} target="_blank" rel="noreferrer">
                {info.repository}
              </a>
            </Row>
          </dl>

          <h2 className="admin-subhead">This host</h2>
          <dl className="about-list">
            <Row label="Site name">{info.siteName}</Row>
            <Row label="Role">{info.role}</Row>
            <Row label="Node.js">{info.node}</Row>
            <Row label="Platform">{info.platform}</Row>
            <Row label="Public IP">{info.publicIp}</Row>
            <Row label="Listen port">{info.port}</Row>
            <Row label="Public URL">{info.publicBaseUrl || "—"}</Row>
            <Row label="Network mode">{info.browserNetworkMode}</Row>
            <Row label="WebRTC ports">{info.webrtcPortRange}</Row>
            <Row label="Enabled browsers">{info.enabledBrowsers.join(", ") || "—"}</Row>
            <Row label="Local worker">{info.localWorkerEnabled ? "yes" : "no"}</Row>
            <Row label="Persistent profiles">{info.persistProfilesEnabled ? "allowed" : "disabled"}</Row>
            <Row label="Database">{info.databasePath}</Row>
            <Row label="Profile data">{info.profileDataDir}</Row>
            <Row label="Secure cookies">{info.cookieSecure ? "yes" : "no"}</Row>
            <Row label="Trust proxy">{info.trustProxy ? "yes" : "no"}</Row>
          </dl>
        </>
      ) : !error ? (
        <p className="hint">Loading…</p>
      ) : null}
    </section>
  );
}
