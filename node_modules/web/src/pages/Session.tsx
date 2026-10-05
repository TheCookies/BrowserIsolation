import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, destroyMySession, getSessionAccess, type Me, type SessionAccess } from "../api";
import { LaunchStatusOverlay } from "../LaunchStatusOverlay";
import { SessionFiles } from "../SessionFiles";
import { hostHasScrollbar, measureSessionStage, VIEWPORT_SLACK_PX } from "../sessionLayout";
import { RemoteDesktop } from "../viewer";
import type { ViewerClient } from "../viewer/client";

export function SessionPage({ me }: { me: Me }) {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const pageRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerClientRef = useRef<ViewerClient | null>(null);
  const [access, setAccess] = useState<SessionAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [filesOpen, setFilesOpen] = useState(false);
  const [files, setFiles] = useState<Array<{ name: string; size: number }>>([]);
  const scrollbarLoggedRef = useRef(false);

  /**
   * Explicit pixel layout:
   *   stageWidth  = window.innerWidth - 5
   *   stageHeight = window.innerHeight - toolbarHeight - 5
   * so the host page can never grow a scrollbar from the WebRTC surface.
   */
  const layoutSession = useCallback(() => {
    const page = pageRef.current;
    const toolbar = toolbarRef.current;
    const stage = stageRef.current;
    if (!page || !stage) return;

    const measured = measureSessionStage(toolbar);

    page.style.width = `${measured.viewportWidth}px`;
    page.style.height = `${measured.viewportHeight}px`;
    page.style.overflow = "hidden";

    stage.style.width = `${measured.stageWidth}px`;
    stage.style.height = `${measured.stageHeight}px`;
    stage.style.maxWidth = `${measured.stageWidth}px`;
    stage.style.maxHeight = `${measured.stageHeight}px`;
    stage.style.overflow = "hidden";

    setStageSize((prev) =>
      prev.width === measured.stageWidth && prev.height === measured.stageHeight
        ? prev
        : { width: measured.stageWidth, height: measured.stageHeight },
    );

    requestAnimationFrame(() => {
      if (!hostHasScrollbar()) {
        scrollbarLoggedRef.current = false;
        return;
      }

      const detail = {
        viewport: { w: measured.viewportWidth, h: measured.viewportHeight },
        toolbarHeight: measured.toolbarHeight,
        stage: { w: measured.stageWidth, h: measured.stageHeight },
        slackPx: VIEWPORT_SLACK_PX,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        bodyScrollHeight: document.body.scrollHeight,
        innerHeight: window.innerHeight,
      };

      console.error("[rbi] host scrollbar detected after session layout", detail);

      let width = measured.stageWidth;
      let height = measured.stageHeight;
      for (let i = 0; i < 20 && hostHasScrollbar(); i += 1) {
        width = Math.max(1, width - 8);
        height = Math.max(1, height - 8);
        stage.style.width = `${width}px`;
        stage.style.maxWidth = `${width}px`;
        stage.style.height = `${height}px`;
        stage.style.maxHeight = `${height}px`;
      }

      if (hostHasScrollbar()) {
        console.error("[rbi] host scrollbar persists after emergency shrink", {
          ...detail,
          finalStage: { w: width, h: height },
        });
      } else {
        setStageSize({ width, height });
        if (!scrollbarLoggedRef.current) {
          scrollbarLoggedRef.current = true;
          console.error("[rbi] host scrollbar cleared by emergency shrink", {
            ...detail,
            finalStage: { w: width, h: height },
          });
        }
      }
    });
  }, []);

  useLayoutEffect(() => {
    layoutSession();
  }, [layoutSession, access, error]);

  useEffect(() => {
    function onResize() {
      layoutSession();
    }
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
    };
  }, [layoutSession]);

  useEffect(() => {
    let cancelled = false;
    setAccess(null);
    setError(null);
    getSessionAccess(sessionId, me.csrfToken)
      .then((result) => {
        if (!cancelled) setAccess(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setError("You do not have access to this session.");
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setError("That browser session is no longer available.");
          return;
        }
        setError(
          err instanceof ApiError && err.message !== err.code
            ? `Unable to open the remote browser: ${err.message}`
            : "Unable to open the remote browser.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [me.csrfToken, sessionId]);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
      layoutSession();
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [layoutSession]);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("session-lock");
    const blockHostScroll = (event: WheelEvent) => {
      event.preventDefault();
    };
    document.addEventListener("wheel", blockHostScroll, { passive: false, capture: true });
    return () => {
      document.removeEventListener("wheel", blockHostScroll, true);
      html.classList.remove("session-lock");
    };
  }, []);

  function disconnect() {
    if (pendingDisconnect || leaving) return;
    setPendingDisconnect(true);
    setLeaving(true);
    // Leave immediately so reconnect overlays never flash; destroy runs in background.
    navigate("/", { replace: true, state: { disconnected: true } });
    void destroyMySession(me.csrfToken).catch(() => {
      /* background cleanup; idle reaper will also reclaim orphans */
    });
  }

  async function toggleFullscreen() {
    const root = pageRef.current;
    try {
      if (!document.fullscreenElement && root) {
        await root.requestFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      /* fullscreen may be blocked */
    }
    layoutSession();
  }

  return (
    <div ref={pageRef} className="session-page">
      <header ref={toolbarRef} className="session-toolbar">
        <button type="button" className="button-quiet" onClick={() => navigate("/")}>
          Dashboard
        </button>
        <span className="session-title">Isolated browser</span>
        {access && !error ? <span className="session-live">Live</span> : null}
        {access?.allowDownloads && !error ? (
          <button type="button" className="button-quiet" onClick={() => setFilesOpen((open) => !open)}>
            {filesOpen ? "Hide files" : "Files"}
          </button>
        ) : null}
        <button type="button" className="button-quiet" onClick={() => void toggleFullscreen()}>
          {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button
          type="button"
          className="button-quiet danger"
          onClick={disconnect}
          disabled={pendingDisconnect || leaving}
        >
          {pendingDisconnect || leaving ? "Disconnecting…" : "Disconnect"}
        </button>
      </header>
      <div ref={stageRef} className="session-stage">
        {leaving ? null : error ? (
          <div className="session-error">
            <p className="alert" role="alert">
              {error}
            </p>
            <Link to="/">Back to dashboard</Link>
          </div>
        ) : access && stageSize.width > 0 && stageSize.height > 0 ? (
          <>
            <RemoteDesktop
              access={access}
              stageWidth={stageSize.width}
              stageHeight={stageSize.height}
              clientRefOut={viewerClientRef}
              onFileTransferList={setFiles}
            />
            {access.allowDownloads ? (
              <SessionFiles
                access={access}
                files={files}
                open={filesOpen}
                onClose={() => setFilesOpen(false)}
                onRefresh={() => viewerClientRef.current?.refreshFileTransfer()}
              />
            ) : null}
          </>
        ) : (
          <LaunchStatusOverlay
            active
            variant="stage"
            title="Preparing remote browser"
            browserTitle="Isolated session"
          />
        )}
      </div>
    </div>
  );
}
