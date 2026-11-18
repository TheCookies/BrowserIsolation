export const LABEL_MANAGED = "rbi.managed";
export const LABEL_OWNER = "rbi.owner";
export const LABEL_SUBJECT_KEY = "rbi.subject_key";
export const LABEL_SESSION = "rbi.session";
export const LABEL_BROWSER = "rbi.browser";
export const LABEL_WEBRTC_PORT = "rbi.webrtc_port";
export const LABEL_X_DISPLAY = "rbi.x_display";

export function managedLabels(input: {
  owner: string;
  /** profileStorageKey(subjectId) — used to find containers sharing a profile. */
  subjectKey?: string;
  sessionId: string;
  browser: string;
  webrtcPort?: number;
  /** X display string, e.g. ":1234" — unique per host-network session. */
  xDisplay?: string;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: "true",
    [LABEL_OWNER]: input.owner,
    [LABEL_SESSION]: input.sessionId,
    [LABEL_BROWSER]: input.browser,
  };
  if (input.subjectKey) {
    labels[LABEL_SUBJECT_KEY] = input.subjectKey;
  }
  if (input.webrtcPort !== undefined) {
    labels[LABEL_WEBRTC_PORT] = String(input.webrtcPort);
  }
  if (input.xDisplay) {
    labels[LABEL_X_DISPLAY] = input.xDisplay;
  }
  return labels;
}
