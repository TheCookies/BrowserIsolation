import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { SessionAccess } from "../api";
import { LaunchStatusOverlay } from "../LaunchStatusOverlay";
import { ViewerClient, type ViewerStatus } from "./client";
import { EVENT } from "./events";
import {
  isDrawableCursor,
  placeCursorSprite,
  type RemoteCursorImage,
} from "./cursor";
import {
  mapPoint,
  normalizeWheelDelta,
  NEKO_WHEEL_THROTTLE_MS,
  preferredScreenSize,
  screensEqual,
} from "./geometry";
import createGuacamoleKeyboard, { type GuacamoleKeyboardInterface } from "./guacamole-keyboard";
import type { ScreenResolution } from "./types";

type Props = {
  access: SessionAccess;
  /** Exact pixel size of the host stage (viewport - toolbar - slack). */
  stageWidth: number;
  stageHeight: number;
  onStreamReady?: (ready: boolean) => void;
  onFileTransferList?: (files: Array<{ name: string; size: number }>) => void;
  clientRefOut?: MutableRefObject<ViewerClient | null>;
};

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 800;
const SCREEN_SET_DEBOUNCE_MS = 400;

const KeyTable = {
  XK_ISO_Level3_Shift: 0xfe03,
  XK_Mode_switch: 0xff7e,
  XK_Control_L: 0xffe3,
  XK_Meta_L: 0xffe7,
  XK_Alt_L: 0xffe9,
  XK_Alt_R: 0xffea,
  XK_Super_L: 0xffeb,
  XK_Super_R: 0xffec,
} as const;

function wsUrlFromPath(wsPath: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${wsPath}`;
}

function hasMacOSKbd(): boolean {
  return /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
}

function mapKeysym(key: number): number {
  if (!hasMacOSKbd()) return key;
  switch (key) {
    case KeyTable.XK_Meta_L:
      return KeyTable.XK_Control_L;
    case KeyTable.XK_Super_L:
      return KeyTable.XK_Alt_L;
    case KeyTable.XK_Super_R:
      return KeyTable.XK_Super_L;
    case KeyTable.XK_Alt_L:
      return KeyTable.XK_Mode_switch;
    case KeyTable.XK_Alt_R:
      return KeyTable.XK_ISO_Level3_Shift;
    default:
      return key;
  }
}

/**
 * Fills the host stage exactly (width + height). Remote desktop is screen/set
 * to the same CSS pixel size so the stream fits the window on every resize.
 */
function canReadHostClipboard(): boolean {
  const ua = navigator.userAgent;
  const isSafari =
    ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium");
  return (
    "clipboard" in navigator &&
    typeof navigator.clipboard.readText === "function" &&
    !ua.includes("Firefox") &&
    !isSafari
  );
}

function canWriteHostClipboard(): boolean {
  return "clipboard" in navigator && typeof navigator.clipboard.writeText === "function";
}

export function RemoteDesktop({
  access,
  stageWidth,
  stageHeight,
  onStreamReady,
  onFileTransferList,
  clientRefOut,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorRef = useRef<HTMLImageElement>(null);
  const cursorImageRef = useRef<RemoteCursorImage | null>(null);
  const cursorUrlRef = useRef<string | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const placeRemoteCursorRef = useRef<(pointer: { x: number; y: number } | null) => void>(() => {});
  const showRemoteCursorRef = useRef<(image: RemoteCursorImage) => void>(() => {});
  const stageWidthRef = useRef(stageWidth);
  const stageHeightRef = useRef(stageHeight);
  stageWidthRef.current = stageWidth;
  stageHeightRef.current = stageHeight;
  const audioRef = useRef<HTMLAudioElement>(null);
  const overlayRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<ViewerClient | null>(null);
  const resolutionRef = useRef<ScreenResolution | null>(null);
  const lastScreenSetRef = useRef<ScreenResolution | null>(null);
  const keyboardRef = useRef<GuacamoleKeyboardInterface | null>(null);
  const audioUnlockedRef = useRef(false);
  const closedRef = useRef(false);
  const peerReadyRef = useRef(false);
  const frameReadyRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const screenTimerRef = useRef<number | undefined>(undefined);
  const wheelThrottleRef = useRef(false);
  const lastClipboardRef = useRef("");
  const allowClipboard = access.allowClipboard;

  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [needsAudioGesture, setNeedsAudioGesture] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [remoteCursorActive, setRemoteCursorActive] = useState(false);

  const publishStreamReady = useCallback(
    (ready: boolean) => {
      setStreamReady(ready);
      onStreamReady?.(ready);
    },
    [onStreamReady],
  );

  const markFrameReady = useCallback(() => {
    if (closedRef.current || frameReadyRef.current) return;
    frameReadyRef.current = true;
    if (peerReadyRef.current) {
      publishStreamReady(true);
    }
  }, [publishStreamReady]);

  /** Pin the WebRTC surface to the exact host stage pixels (full width + height). */
  const layoutPlayer = useCallback(() => {
    const stage = stageRef.current;
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!stage) return;

    const offsetWidth = stageWidthRef.current;
    const offsetHeight = stageHeightRef.current;
    stage.style.width = `${offsetWidth}px`;
    stage.style.height = `${offsetHeight}px`;
    stage.style.maxWidth = `${offsetWidth}px`;
    stage.style.maxHeight = `${offsetHeight}px`;
    if (video) {
      video.style.width = `${offsetWidth}px`;
      video.style.height = `${offsetHeight}px`;
    }
    if (overlay) {
      overlay.style.width = `${offsetWidth}px`;
      overlay.style.height = `${offsetHeight}px`;
    }
    placeRemoteCursorRef.current(pointerRef.current);
  }, []);

  const applyScreenSize = useCallback(() => {
    const client = clientRef.current;
    if (!client || !peerReadyRef.current) return;
    const next = preferredScreenSize(stageWidthRef.current, stageHeightRef.current);
    if (screensEqual(lastScreenSetRef.current, next)) {
      layoutPlayer();
      return;
    }
    lastScreenSetRef.current = next;
    client.sendMessage(EVENT.SCREEN.SET, next);
    layoutPlayer();
  }, [layoutPlayer]);

  const scheduleScreenSize = useCallback(() => {
    if (screenTimerRef.current) window.clearTimeout(screenTimerRef.current);
    screenTimerRef.current = window.setTimeout(() => {
      screenTimerRef.current = undefined;
      applyScreenSize();
    }, SCREEN_SET_DEBOUNCE_MS);
  }, [applyScreenSize]);

  /**
   * Start the remote audio element. The picture stays on a muted video so it
   * can autoplay; a click or key is what browsers accept for sound.
   */
  const unlockAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!(audio?.srcObject instanceof MediaStream) || audio.srcObject.getAudioTracks().length === 0) {
      return;
    }
    if (audioUnlockedRef.current && !audio.muted && !audio.paused) return;

    audio.muted = false;
    audio.volume = 1;
    try {
      await audio.play();
      audioUnlockedRef.current = true;
      setNeedsAudioGesture(false);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "AbortError" && !audio.paused && !audio.muted) {
        audioUnlockedRef.current = true;
        setNeedsAudioGesture(false);
        return;
      }
      audioUnlockedRef.current = false;
      setNeedsAudioGesture(true);
    }
  }, []);

  function sendMousePos(clientX: number, clientY: number) {
    const client = clientRef.current;
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (!client || !overlay || !video || !streamReady) return;
    const point = mapPoint(clientX, clientY, overlay, resolutionRef.current, video);
    client.sendData("mousemove", point);
  }

  function hideRemoteCursor() {
    const cursor = cursorRef.current;
    if (cursor) cursor.style.display = "none";
  }

  function releaseCursorUrl() {
    if (!cursorUrlRef.current) return;
    URL.revokeObjectURL(cursorUrlRef.current);
    cursorUrlRef.current = null;
  }

  /** Draw the remote cursor so its hotspot is the pointer inside the stage. */
  function placeRemoteCursor(pointer: { x: number; y: number } | null) {
    const cursor = cursorRef.current;
    const stage = stageRef.current;
    const image = cursorImageRef.current;
    if (!cursor || !stage || !image || !isDrawableCursor(image) || !pointer) {
      hideRemoteCursor();
      return;
    }
    const rect = stage.getBoundingClientRect();
    const screen = resolutionRef.current;
    const placed = placeCursorSprite({
      pointerX: pointer.x,
      pointerY: pointer.y,
      boxWidth: rect.width,
      boxHeight: rect.height,
      screenWidth: screen?.width || rect.width,
      screenHeight: screen?.height || rect.height,
      imageWidth: image.width,
      imageHeight: image.height,
      hotspotX: image.hotspotX,
      hotspotY: image.hotspotY,
    });
    if (!placed) {
      hideRemoteCursor();
      return;
    }
    cursor.style.display = "block";
    cursor.style.left = `${placed.left}px`;
    cursor.style.top = `${placed.top}px`;
    cursor.style.width = `${placed.width}px`;
    cursor.style.height = `${placed.height}px`;
  }

  function trackPointer(clientX: number, clientY: number) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const pointer = { x: clientX - rect.left, y: clientY - rect.top };
    pointerRef.current = pointer;
    const image = cursorImageRef.current;
    if (image && isDrawableCursor(image)) setRemoteCursorActive(true);
    placeRemoteCursor(pointer);
  }

  function showRemoteCursor(image: RemoteCursorImage) {
    cursorImageRef.current = image;
    const cursor = cursorRef.current;
    if (!cursor || !isDrawableCursor(image)) {
      releaseCursorUrl();
      if (cursor) cursor.removeAttribute("src");
      hideRemoteCursor();
      // Remote browser hid its pointer (blank cursor). Don't keep the local arrow.
      setRemoteCursorActive(true);
      return;
    }
    const copy = new Uint8Array(image.png);
    const url = URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: "image/png" }));
    const previous = cursorUrlRef.current;
    cursorUrlRef.current = url;
    cursor.src = url;
    if (previous) URL.revokeObjectURL(previous);
    if (pointerRef.current) {
      setRemoteCursorActive(true);
      placeRemoteCursor(pointerRef.current);
      return;
    }
    // Keep the OS cursor until the pointer is over the stage and the sprite can replace it.
    setRemoteCursorActive(false);
    hideRemoteCursor();
  }

  placeRemoteCursorRef.current = placeRemoteCursor;
  showRemoteCursorRef.current = showRemoteCursor;

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!streamReady || !clientRef.current) return;

    const { x, y } = normalizeWheelDelta(event.deltaX, event.deltaY, event.deltaMode);
    trackPointer(event.clientX, event.clientY);
    sendMousePos(event.clientX, event.clientY);

    if (wheelThrottleRef.current) return;
    wheelThrottleRef.current = true;
    clientRef.current.sendData("wheel", { x, y });
    window.setTimeout(() => {
      wheelThrottleRef.current = false;
    }, NEKO_WHEEL_THROTTLE_MS);
  }

  useEffect(() => {
    let cancelled = false;
    closedRef.current = false;
    cursorImageRef.current = null;
    pointerRef.current = null;
    releaseCursorUrl();
    hideRemoteCursor();
    setRemoteCursorActive(false);
    if (!videoRef.current || !audioRef.current) return;
    const videoEl: HTMLVideoElement = videoRef.current;
    const audioEl: HTMLAudioElement = audioRef.current;
    videoEl.muted = true;
    videoEl.volume = 1;
    audioEl.volume = 1;
    const url = wsUrlFromPath(access.wsPath);

    const onVideoFrame = () => {
      if (!cancelled) markFrameReady();
    };
    videoEl.addEventListener("loadeddata", onVideoFrame);
    const videoWithFrameCb = videoEl as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    let frameCallbackId: number | undefined;
    if (videoWithFrameCb.requestVideoFrameCallback) {
      frameCallbackId = videoWithFrameCb.requestVideoFrameCallback(() => {
        if (!cancelled) markFrameReady();
      });
    }

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = undefined;
      }
    }

    function stopElementStream(el: HTMLMediaElement) {
      const stream = el.srcObject;
      el.srcObject = null;
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) track.stop();
      }
    }

    function resetMedia() {
      const shared =
        videoEl.srcObject instanceof MediaStream && videoEl.srcObject === audioEl.srcObject;
      stopElementStream(videoEl);
      if (!shared) stopElementStream(audioEl);
      else audioEl.srcObject = null;
      audioUnlockedRef.current = false;
      if (!cancelled) setNeedsAudioGesture(false);
      peerReadyRef.current = false;
      frameReadyRef.current = false;
      lastScreenSetRef.current = null;
      if (!cancelled) publishStreamReady(false);
    }

    function connectOnce() {
      if (cancelled || closedRef.current) return;

      const client = new ViewerClient({
        onStatus(next, message) {
          if (cancelled) return;
          setStatus(next);
          setDetail(message ?? null);

          if (next === "connected") {
            peerReadyRef.current = true;
            reconnectAttemptRef.current = 0;
            setReconnectAttempt(0);
            applyScreenSize();
            if (frameReadyRef.current) publishStreamReady(true);
            if (access.allowDownloads) {
              client.refreshFileTransfer();
            }
            return;
          }

          if (next === "connecting") {
            peerReadyRef.current = false;
            publishStreamReady(false);
            return;
          }

          if (next === "reconnecting") return;

          if (next === "disconnected") {
            peerReadyRef.current = false;
            publishStreamReady(false);
            if (closedRef.current || cancelled) return;

            const attempt = reconnectAttemptRef.current;
            if (attempt >= MAX_RECONNECT_ATTEMPTS) {
              setDetail(message ? `${message} (reconnect failed)` : "reconnect failed");
              return;
            }
            const nextAttempt = attempt + 1;
            reconnectAttemptRef.current = nextAttempt;
            setReconnectAttempt(nextAttempt);
            setStatus("reconnecting");
            clearReconnectTimer();
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = undefined;
              if (cancelled || closedRef.current) return;
              clientRef.current?.close();
              clientRef.current = null;
              if (clientRefOut) clientRefOut.current = null;
              resetMedia();
              connectOnce();
            }, RECONNECT_BASE_MS * 2 ** attempt);
          }
        },
        onResolution(resolution) {
          resolutionRef.current = resolution;
          layoutPlayer();
        },
        onClipboard(text) {
          if (cancelled || !allowClipboard || !canWriteHostClipboard()) return;
          lastClipboardRef.current = text;
          void navigator.clipboard.writeText(text).catch(() => undefined);
        },
        onFileTransferList(files) {
          if (!cancelled) onFileTransferList?.(files);
        },
        onCursorImage(image) {
          if (!cancelled) showRemoteCursorRef.current(image);
        },
        onTrack(event) {
          if (cancelled) return;
          const track = event.track;
          track.enabled = true;
          const incoming = event.streams[0];
          // Chrome stays silent if the audio track is copied into a new
          // MediaStream, and a muted video mutes every element sharing that
          // stream. Keep the server's stream on the audio element. The
          // picture uses only the video track, so it can stay muted.
          const original =
            incoming && incoming.getTracks().some((item) => item.id === track.id)
              ? incoming
              : new MediaStream([track]);

          if (track.kind === "video") {
            const current = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
            const picture =
              current && current !== original && current.getAudioTracks().length === 0
                ? current
                : new MediaStream();
            if (!picture.getTracks().some((item) => item.id === track.id)) picture.addTrack(track);
            videoEl.muted = true;
            videoEl.volume = 1;
            if (videoEl.srcObject !== picture) videoEl.srcObject = picture;
            void videoEl.play().catch(() => undefined);
            layoutPlayer();
          }

          if (track.kind === "audio" && audioEl.srcObject !== original) {
            audioEl.srcObject = original;
            audioEl.muted = false;
            audioEl.volume = 1;
            void unlockAudio();
          }
        },
      });
      clientRef.current = client;
      if (clientRefOut) clientRefOut.current = client;
      client.connect(url, access.password, access.username);
    }

    connectOnce();

    return () => {
      cancelled = true;
      closedRef.current = true;
      clearReconnectTimer();
      if (screenTimerRef.current) {
        window.clearTimeout(screenTimerRef.current);
        screenTimerRef.current = undefined;
      }
      videoEl.removeEventListener("loadeddata", onVideoFrame);
      if (frameCallbackId !== undefined) {
        videoWithFrameCb.cancelVideoFrameCallback?.(frameCallbackId);
      }
      clientRef.current?.close();
      clientRef.current = null;
      if (clientRefOut) clientRefOut.current = null;
      resetMedia();
      audioUnlockedRef.current = false;
      releaseCursorUrl();
      cursorImageRef.current = null;
      hideRemoteCursor();
      publishStreamReady(false);
    };
  }, [
    access.password,
    access.username,
    access.wsPath,
    access.allowDownloads,
    allowClipboard,
    applyScreenSize,
    clientRefOut,
    layoutPlayer,
    markFrameReady,
    onFileTransferList,
    publishStreamReady,
    unlockAudio,
  ]);

  useEffect(() => {
    if (!allowClipboard || !streamReady) return;

    async function syncHostClipboardToRemote() {
      if (!canReadHostClipboard() || !document.hasFocus()) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text === lastClipboardRef.current) return;
        lastClipboardRef.current = text;
        clientRef.current?.sendClipboard(text);
      } catch {
        /* permission denied or unsupported */
      }
    }

    function onFocus() {
      void syncHostClipboardToRemote();
    }

    window.addEventListener("focus", onFocus);
    void syncHostClipboardToRemote();
    return () => window.removeEventListener("focus", onFocus);
  }, [allowClipboard, streamReady]);

  // Parent SessionPage owns resize; re-layout + screen/set whenever stage pixels change.
  useEffect(() => {
    layoutPlayer();
    scheduleScreenSize();
  }, [layoutPlayer, scheduleScreenSize, stageWidth, stageHeight]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
    // onWheel closes over streamReady via render; rebind when readiness changes.
  }, [streamReady]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !streamReady) return;

    const keyboard = createGuacamoleKeyboard();
    keyboardRef.current = keyboard;
    keyboard.onkeydown = (keysym) => {
      void unlockAudio();
      const client = clientRef.current;
      if (!client) return true;
      client.sendData("keydown", { key: mapKeysym(keysym) });
      return false;
    };
    keyboard.onkeyup = (keysym) => {
      clientRef.current?.sendData("keyup", { key: mapKeysym(keysym) });
    };
    keyboard.listenTo(overlay);
    overlay.focus();

    return () => {
      keyboard.reset();
      keyboard.onkeydown = undefined;
      keyboard.onkeyup = undefined;
      keyboardRef.current = null;
    };
  }, [streamReady, unlockAudio]);

  const showOverlay = !streamReady;

  return (
    <div ref={stageRef} className="remote-desktop">
      <video ref={videoRef} className="remote-video" autoPlay playsInline />
      <img
        ref={cursorRef}
        className="remote-cursor"
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => {
          hideRemoteCursor();
          setRemoteCursorActive(false);
        }}
      />
      <textarea
        ref={overlayRef}
        className={remoteCursorActive ? "remote-overlay has-remote-cursor" : "remote-overlay"}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label="Remote browser input"
        onContextMenu={(event) => event.preventDefault()}
        onMouseMove={(event) => {
          event.preventDefault();
          trackPointer(event.clientX, event.clientY);
          sendMousePos(event.clientX, event.clientY);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          overlayRef.current?.focus();
          void unlockAudio();
          trackPointer(event.clientX, event.clientY);
          sendMousePos(event.clientX, event.clientY);
          clientRef.current?.sendData("mousedown", { key: event.button + 1 });
        }}
        onMouseUp={(event) => {
          event.preventDefault();
          trackPointer(event.clientX, event.clientY);
          sendMousePos(event.clientX, event.clientY);
          clientRef.current?.sendData("mouseup", { key: event.button + 1 });
        }}
        onScroll={(event) => {
          const target = event.currentTarget;
          if (target.scrollTop !== 0 || target.scrollLeft !== 0) {
            target.scrollTop = 0;
            target.scrollLeft = 0;
          }
        }}
        onMouseLeave={() => {
          pointerRef.current = null;
          hideRemoteCursor();
          keyboardRef.current?.reset();
        }}
        onPaste={(event) => {
          // Never let local paste land in the overlay textarea.
          event.preventDefault();
          if (!allowClipboard) return;
          const text = event.clipboardData?.getData("text") ?? "";
          if (!text) return;
          lastClipboardRef.current = text;
          clientRef.current?.sendClipboard(text);
        }}
        onCopy={(event) => {
          if (!allowClipboard) {
            event.preventDefault();
          }
        }}
        onCut={(event) => {
          if (!allowClipboard) {
            event.preventDefault();
          }
        }}
      />
      <audio ref={audioRef} autoPlay />
      {needsAudioGesture && streamReady ? (
        <button type="button" className="remote-audio-hint" onClick={() => void unlockAudio()}>
          Click to enable sound
        </button>
      ) : null}
      {showOverlay ? (
        status === "connecting" || status === "reconnecting" || status === "idle" ? (
          <LaunchStatusOverlay
            active
            variant="stage"
            title={
              status === "reconnecting"
                ? `Reconnecting… (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`
                : "Connecting to remote browser"
            }
            browserTitle={access.session.browser}
          />
        ) : (
          <div className="remote-status" role="status">
            {detail ? `Disconnected: ${detail}` : "Waiting for remote browser…"}
          </div>
        )
      ) : null}
    </div>
  );
}
