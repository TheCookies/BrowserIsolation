import { useEffect, useState } from "react";
import { pickLaunchStatusLine } from "./launchStatus";

const ROTATE_MS = 2200;

export function LaunchStatusOverlay({
  active,
  title = "Launching remote browser",
  browserTitle,
  variant = "modal",
}: {
  active: boolean;
  title?: string;
  browserTitle?: string | null;
  /** modal = full-screen popup on dashboard; stage = embedded in session stage */
  variant?: "modal" | "stage";
}) {
  const [line, setLine] = useState(() => pickLaunchStatusLine());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    setLine(pickLaunchStatusLine());
    setTick(0);
    const rotate = window.setInterval(() => {
      setLine((current) => pickLaunchStatusLine(current));
      setTick((value) => value + 1);
    }, ROTATE_MS);
    return () => window.clearInterval(rotate);
  }, [active]);

  if (!active) return null;

  const body = (
    <div
      className={`launch-status-panel${variant === "modal" ? " launch-status-modal" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="launch-status-orb" aria-hidden="true">
        <span className="launch-status-ring" />
        <span className="launch-status-ring delay" />
        <span className="launch-status-core" />
      </div>
      <p className="launch-status-kicker">{title}</p>
      {browserTitle ? <p className="launch-status-browser">{browserTitle}</p> : null}
      <p className="launch-status-line" key={`${tick}-${line}`}>
        {line}
      </p>
      <div className="launch-status-track" aria-hidden="true">
        <span className="launch-status-fill" />
      </div>
    </div>
  );

  if (variant === "stage") {
    return <div className="launch-status-stage">{body}</div>;
  }

  return (
    <div className="modal-backdrop launch-status-backdrop" role="presentation">
      {body}
    </div>
  );
}
