export const LABEL_MANAGED = "rbi.managed";
export const LABEL_OWNER = "rbi.owner";
export const LABEL_SESSION = "rbi.session";
export const LABEL_BROWSER = "rbi.browser";
export const LABEL_WEBRTC_PORT = "rbi.webrtc_port";

export function managedLabels(input: {
  owner: string;
  sessionId: string;
  browser: string;
  webrtcPort?: number;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: "true",
    [LABEL_OWNER]: input.owner,
    [LABEL_SESSION]: input.sessionId,
    [LABEL_BROWSER]: input.browser,
  };
  if (input.webrtcPort !== undefined) {
    labels[LABEL_WEBRTC_PORT] = String(input.webrtcPort);
  }
  return labels;
}
