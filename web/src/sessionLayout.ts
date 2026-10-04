/** Keep 5px of slack on each axis so the host browser never grows a scrollbar. */
export const VIEWPORT_SLACK_PX = 5;

export type SessionStageSize = {
  viewportWidth: number;
  viewportHeight: number;
  toolbarHeight: number;
  stageWidth: number;
  stageHeight: number;
};

/**
 * Pure sizing:
 *   stageWidth  = viewportWidth  - 5
 *   stageHeight = viewportHeight - toolbarHeight - 5
 */
export function computeStageSize(
  viewportWidth: number,
  viewportHeight: number,
  toolbarHeight: number,
): SessionStageSize {
  const vw = Math.max(1, Math.floor(viewportWidth));
  const vh = Math.max(1, Math.floor(viewportHeight));
  const th = Math.max(0, Math.ceil(toolbarHeight));
  return {
    viewportWidth: vw,
    viewportHeight: vh,
    toolbarHeight: th,
    stageWidth: Math.max(1, vw - VIEWPORT_SLACK_PX),
    stageHeight: Math.max(1, vh - th - VIEWPORT_SLACK_PX),
  };
}

export function measureSessionStage(toolbar: HTMLElement | null): SessionStageSize {
  const toolbarHeight =
    toolbar && toolbar.offsetParent !== null ? toolbar.getBoundingClientRect().height : 0;
  return computeStageSize(window.innerWidth, window.innerHeight, toolbarHeight);
}

/** True when the host document can scroll vertically or horizontally. */
export function hostHasScrollbar(): boolean {
  const doc = document.documentElement;
  const body = document.body;
  const vertical =
    doc.scrollHeight > doc.clientHeight + 1 ||
    body.scrollHeight > window.innerHeight + 1 ||
    window.scrollY > 0;
  const horizontal =
    doc.scrollWidth > doc.clientWidth + 1 ||
    body.scrollWidth > window.innerWidth + 1 ||
    window.scrollX > 0;
  return vertical || horizontal;
}
