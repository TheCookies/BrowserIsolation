/** Quirky status lines shown while a remote browser is launching or connecting. */
export const LAUNCH_STATUS_LINES = [
  "Firing up the engines…",
  "Testing the flux capacitors…",
  "Warming the isolation chamber…",
  "Calibrating the remote pixels…",
  "Spinning up a disposable container…",
  "Polishing the clipboard forcefield…",
  "Negotiating with the spacetime continuum…",
  "Bribing the WebRTC gremlins…",
  "Inflating the sandbox balloons…",
  "Reticulating browser splines…",
  "Herding packet cats…",
  "Charging the containment fields…",
  "Unfolding a temporary universe…",
  "Tightening the threat-proof bolts…",
  "Syncing the quantum mouse cursor…",
  "Asking the cloud politely…",
  "Bootstrapping a safer tomorrow…",
  "Checking under the digital sofa…",
] as const;

export function pickLaunchStatusLine(exclude?: string | null): string {
  const lines = LAUNCH_STATUS_LINES as readonly string[];
  if (lines.length === 0) return "Starting remote browser…";
  if (lines.length === 1) return lines[0]!;
  let next = lines[Math.floor(Math.random() * lines.length)]!;
  let guard = 0;
  while (exclude && next === exclude && guard < 8) {
    next = lines[Math.floor(Math.random() * lines.length)]!;
    guard += 1;
  }
  return next;
}
