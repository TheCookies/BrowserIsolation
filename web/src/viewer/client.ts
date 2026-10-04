/* Concrete Neko signaling client for the Browser Isolation portal viewer. */

import { BaseClient } from "./base";
import { EVENT } from "./events";
import type {
  ControlClipboardPayload,
  FileTransferListPayload,
  SystemInitPayload,
  ScreenResolutionPayload,
} from "./messages";
import type { ScreenResolution } from "./types";

export type ViewerStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export type ViewerClientCallbacks = {
  onStatus: (status: ViewerStatus, detail?: string) => void;
  onTrack: (event: RTCTrackEvent) => void;
  onResolution?: (resolution: ScreenResolution) => void;
  onClipboard?: (text: string) => void;
  onFileTransferList?: (files: FileTransferListPayload["files"]) => void;
};

export class ViewerClient extends BaseClient {
  private callbacks: ViewerClientCallbacks;
  private heartbeatMs = 0;
  private implicitHosting = true;

  constructor(callbacks: ViewerClientCallbacks) {
    super();
    this.callbacks = callbacks;
    this.on("error", (error: Error) => {
      this.callbacks.onStatus("disconnected", error.message);
    });
  }

  get isImplicitHosting() {
    return this.implicitHosting;
  }

  requestControl() {
    this.sendMessage(EVENT.CONTROL.REQUEST);
  }

  sendClipboard(text: string) {
    this.sendMessage(EVENT.CONTROL.CLIPBOARD, { text } satisfies ControlClipboardPayload);
  }

  refreshFileTransfer() {
    this.sendMessage(EVENT.FILETRANSFER.REFRESH);
  }

  close() {
    this.disconnect();
  }

  protected [EVENT.CONNECTING]() {
    this.callbacks.onStatus("connecting");
  }

  protected [EVENT.RECONNECTING]() {
    this.callbacks.onStatus("reconnecting");
  }

  protected [EVENT.CONNECTED]() {
    this.callbacks.onStatus("connected");
    if (!this.implicitHosting) {
      this.requestControl();
    }
  }

  protected [EVENT.DISCONNECTED](reason?: Error) {
    this.callbacks.onStatus("disconnected", reason?.message);
  }

  protected [EVENT.TRACK](event: RTCTrackEvent) {
    this.callbacks.onTrack(event);
  }

  protected [EVENT.DATA](_data: unknown) {
    /* cursor overlays unused in this viewer */
  }

  protected [EVENT.SYSTEM.INIT](payload: SystemInitPayload) {
    this.implicitHosting = Boolean(payload.implicit_hosting);
    if (payload.heartbeat_interval > 0) {
      this.heartbeatMs = payload.heartbeat_interval * 1000;
      if (this._wsHeartbeat) clearInterval(this._wsHeartbeat);
      this._wsHeartbeat = window.setInterval(() => {
        this.sendMessage(EVENT.CLIENT.HEARTBEAT);
      }, this.heartbeatMs);
    }
  }

  protected [EVENT.SYSTEM.DISCONNECT](payload: { title?: string; message?: string }) {
    const detail = [payload.title, payload.message].filter(Boolean).join(": ");
    this.callbacks.onStatus("disconnected", detail || "remote session ended");
  }

  protected [EVENT.SCREEN.RESOLUTION](payload: ScreenResolutionPayload) {
    this.callbacks.onResolution?.({
      width: payload.width,
      height: payload.height,
      rate: payload.rate,
    });
  }

  protected [EVENT.CONTROL.CLIPBOARD](payload: ControlClipboardPayload) {
    if (typeof payload?.text === "string") {
      this.callbacks.onClipboard?.(payload.text);
    }
  }

  protected [EVENT.FILETRANSFER.LIST](payload: FileTransferListPayload) {
    this.callbacks.onFileTransferList?.(Array.isArray(payload?.files) ? payload.files : []);
  }
}
