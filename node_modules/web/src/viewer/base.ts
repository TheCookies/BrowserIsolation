/* Derived from m1k1o/neko client/src/neko/base.ts (Apache-2.0). Modified for Browser Isolation. */

import EventEmitter from "eventemitter3";
import { OPCODE } from "./data";
import { EVENT, type WebSocketEvents } from "./events";
import type {
  SignalAnswerMessage,
  SignalCandidatePayload,
  SignalOfferPayload,
  SignalProvidePayload,
  WebSocketMessages,
  WebSocketPayloads,
} from "./messages";

export type BaseEvents = {
  info: (...message: unknown[]) => void;
  warn: (...message: unknown[]) => void;
  debug: (...message: unknown[]) => void;
  error: (error: Error) => void;
};

export abstract class BaseClient extends EventEmitter {
  protected _ws?: WebSocket;
  protected _wsHeartbeat?: number;
  protected _peer?: RTCPeerConnection;
  protected _channel?: RTCDataChannel;
  protected _timeout?: number;
  protected _displayname?: string;
  protected _state: RTCIceConnectionState = "disconnected";
  protected _id = "";
  protected _candidates: RTCIceCandidate[] = [];

  get id() {
    return this._id;
  }

  get supported() {
    return (
      typeof RTCPeerConnection !== "undefined" &&
      typeof RTCPeerConnection.prototype.addTransceiver !== "undefined"
    );
  }

  get socketOpen() {
    return typeof this._ws !== "undefined" && this._ws.readyState === WebSocket.OPEN;
  }

  get peerConnected() {
    return (
      typeof this._peer !== "undefined" &&
      ["connected", "checking", "completed"].includes(this._state)
    );
  }

  get connected() {
    return this.peerConnected && this.socketOpen;
  }

  public connect(url: string, password: string, displayname: string) {
    if (this.socketOpen) {
      this.emit("warn", "attempting to create websocket while connection open");
      return;
    }

    if (!this.supported) {
      this.onDisconnected(new Error("browser does not support webrtc (RTCPeerConnection missing)"));
      return;
    }

    this._displayname = displayname;
    this[EVENT.CONNECTING]();

    try {
      // Legacy Neko WS auth accepts password/username; also send pwd/usr for compatibility.
      const separator = url.includes("?") ? "&" : "?";
      const auth =
        `password=${encodeURIComponent(password)}` +
        `&username=${encodeURIComponent(displayname)}` +
        `&pwd=${encodeURIComponent(password)}` +
        `&usr=${encodeURIComponent(displayname)}`;
      this._ws = new WebSocket(`${url}${separator}${auth}`);
      this.emit("debug", `connecting to ${this._ws.url.replace(/password=[^&]+/, "password=***")}`);
      this._ws.onmessage = (event) => {
        void this.onMessage(event);
      };
      this._ws.onerror = () => {
        this.onError(new Error("websocket error"));
      };
      this._ws.onclose = () => {
        this.onDisconnected(new Error("websocket closed"));
      };
      this._timeout = window.setTimeout(() => this.onTimeout(), 15000);
    } catch (err) {
      this.onDisconnected(err instanceof Error ? err : new Error(String(err)));
    }
  }

  protected disconnect() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = undefined;
    }

    if (this._wsHeartbeat) {
      clearInterval(this._wsHeartbeat);
      this._wsHeartbeat = undefined;
    }

    if (this._ws) {
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
      this._ws = undefined;
    }

    if (this._channel) {
      this._channel.onmessage = null;
      this._channel.onerror = null;
      this._channel.onclose = null;
      try {
        this._channel.close();
      } catch {
        /* ignore */
      }
      this._channel = undefined;
    }

    if (this._peer) {
      this._peer.onconnectionstatechange = null;
      this._peer.onsignalingstatechange = null;
      this._peer.oniceconnectionstatechange = null;
      this._peer.ontrack = null;
      this._peer.onicecandidate = null;
      this._peer.onnegotiationneeded = null;
      try {
        this._peer.close();
      } catch {
        /* ignore */
      }
      this._peer = undefined;
    }

    this._state = "disconnected";
    this._displayname = undefined;
    this._id = "";
  }

  public sendData(event: "wheel" | "mousemove", data: { x: number; y: number }): void;
  public sendData(event: "mousedown" | "mouseup" | "keydown" | "keyup", data: { key: number }): void;
  public sendData(event: string, data: { x?: number; y?: number; key?: number }) {
    if (!this.connected || !this._channel) {
      return;
    }

    let buffer: ArrayBuffer | undefined;
    switch (event) {
      case "mousemove": {
        buffer = new ArrayBuffer(7);
        const payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.MOVE);
        payload.setUint16(1, 4, true);
        payload.setUint16(3, data.x ?? 0, true);
        payload.setUint16(5, data.y ?? 0, true);
        break;
      }
      case "wheel": {
        buffer = new ArrayBuffer(7);
        const payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.SCROLL);
        payload.setUint16(1, 4, true);
        payload.setInt16(3, data.x ?? 0, true);
        payload.setInt16(5, data.y ?? 0, true);
        break;
      }
      case "keydown":
      case "mousedown": {
        buffer = new ArrayBuffer(11);
        const payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.KEY_DOWN);
        payload.setUint16(1, 8, true);
        payload.setBigUint64(3, BigInt(data.key ?? 0), true);
        break;
      }
      case "keyup":
      case "mouseup": {
        buffer = new ArrayBuffer(11);
        const payload = new DataView(buffer);
        payload.setUint8(0, OPCODE.KEY_UP);
        payload.setUint16(1, 8, true);
        payload.setBigUint64(3, BigInt(data.key ?? 0), true);
        break;
      }
      default:
        this.emit("warn", `unknown data event: ${event}`);
        return;
    }

    try {
      this._channel.send(buffer);
    } catch (err) {
      this.emit("warn", "failed to send datachannel payload", err);
    }
  }

  public sendMessage(event: WebSocketEvents, payload?: WebSocketPayloads) {
    if (!this.socketOpen || !this._ws) {
      this.emit("warn", "attempting to send message while socket closed");
      return;
    }
    this.emit("debug", `sending event '${event}'`, payload);
    this._ws.send(JSON.stringify({ event, ...payload }));
  }

  public async createPeer(lite: boolean, servers: RTCIceServer[]) {
    this.emit("debug", "creating peer");
    if (!this.socketOpen) {
      this.emit("warn", "attempting to create peer with no websocket");
      return;
    }

    if (this.peerConnected) {
      this.emit("warn", "attempting to create peer while connected");
      return;
    }

    this._peer =
      lite === true
        ? new RTCPeerConnection()
        : new RTCPeerConnection({
            iceServers: servers,
          });

    this._peer.onconnectionstatechange = () => {
      this.emit("debug", "peer connection state changed", this._peer?.connectionState);
    };

    this._peer.onsignalingstatechange = () => {
      this.emit("debug", "peer signaling state changed", this._peer?.signalingState);
    };

    this._peer.oniceconnectionstatechange = () => {
      this._state = this._peer!.iceConnectionState;
      this.emit("debug", `peer ice connection state changed: ${this._peer!.iceConnectionState}`);

      switch (this._state) {
        case "checking":
          if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = undefined;
          }
          break;
        case "connected":
          this.onConnected();
          break;
        case "disconnected":
          this[EVENT.RECONNECTING]();
          break;
        case "failed":
          this.onDisconnected(new Error("peer failed"));
          break;
        case "closed":
          this.onDisconnected(new Error("peer closed"));
          break;
      }
    };

    this._peer.ontrack = (event) => this.onTrack(event);

    this._peer.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate || !this._ws) {
        return;
      }
      const init = event.candidate.toJSON();
      this._ws.send(
        JSON.stringify({
          event: EVENT.SIGNAL.CANDIDATE,
          data: JSON.stringify(init),
        }),
      );
    };

    this._peer.onnegotiationneeded = () => {
      void (async () => {
        if (!this._peer || !this._ws) return;
        const offer = await this._peer.createOffer();
        await this._peer.setLocalDescription(offer);
        this._ws.send(
          JSON.stringify({
            event: EVENT.SIGNAL.OFFER,
            sdp: offer.sdp,
          }),
        );
      })();
    };

    this._channel = this._peer.createDataChannel("data");
    this._channel.onerror = () => this.onError(new Error("datachannel error"));
    this._channel.onmessage = (event) => this.onData(event);
    this._channel.onclose = () => this.onDisconnected(new Error("peer data channel closed"));
  }

  public async setRemoteOffer(sdp: string) {
    if (!this._peer) {
      this.emit("warn", "attempting to set remote offer while disconnected");
      return;
    }

    await this._peer.setRemoteDescription({ type: "offer", sdp });

    for (const candidate of this._candidates) {
      await this._peer.addIceCandidate(candidate);
    }
    this._candidates = [];

    try {
      const answer = await this._peer.createAnswer();
      answer.sdp = answer.sdp?.replace(/(stereo=1;)?useinbandfec=1/, "useinbandfec=1;stereo=1");
      await this._peer.setLocalDescription(answer);
      this._ws!.send(
        JSON.stringify({
          event: EVENT.SIGNAL.ANSWER,
          sdp: answer.sdp,
          displayname: this._displayname,
        }),
      );
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  public async setRemoteAnswer(sdp: string) {
    if (!this._peer) {
      this.emit("warn", "attempting to set remote answer while disconnected");
      return;
    }
    await this._peer.setRemoteDescription({ type: "answer", sdp });
  }

  private async onMessage(e: MessageEvent) {
    const { event, ...payload } = JSON.parse(String(e.data)) as WebSocketMessages;
    this.emit("debug", `received websocket event ${event}`, payload);

    if (event === EVENT.SIGNAL.PROVIDE) {
      const { sdp, lite, ice, id } = payload as SignalProvidePayload;
      this._id = id;
      await this.createPeer(lite, ice);
      await this.setRemoteOffer(sdp);
      return;
    }

    if (event === EVENT.SIGNAL.OFFER) {
      const { sdp } = payload as SignalOfferPayload;
      await this.setRemoteOffer(sdp);
      return;
    }

    if (event === EVENT.SIGNAL.ANSWER) {
      const { sdp } = payload as SignalAnswerMessage;
      await this.setRemoteAnswer(sdp);
      return;
    }

    if (event === EVENT.SIGNAL.CANDIDATE) {
      const { data } = payload as SignalCandidatePayload;
      const candidate = JSON.parse(data) as RTCIceCandidateInit;
      if (this._peer) {
        await this._peer.addIceCandidate(candidate);
      } else {
        this._candidates.push(candidate as RTCIceCandidate);
      }
      return;
    }

    const handler = (this as unknown as Record<string, ((p: unknown) => void) | undefined>)[event];
    if (typeof handler === "function") {
      handler.call(this, payload);
      return;
    }
    this[EVENT.MESSAGE](event, payload);
  }

  private onData(e: MessageEvent) {
    this[EVENT.DATA](e.data);
  }

  private onTrack(event: RTCTrackEvent) {
    this.emit("debug", `received ${event.track.kind} track from peer: ${event.track.id}`);
    this[EVENT.TRACK](event);
  }

  private onError(error: Error) {
    this.emit("error", error);
  }

  private onConnected() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = undefined;
    }
    if (!this.connected) {
      this.emit("warn", "onConnected called while being disconnected");
      return;
    }
    this.emit("debug", "connected");
    this[EVENT.CONNECTED]();
  }

  private onTimeout() {
    this.emit("debug", "connection timeout");
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = undefined;
    }
    this.onDisconnected(new Error("connection timeout"));
  }

  protected onDisconnected(reason?: Error) {
    this.disconnect();
    this.emit("debug", "disconnected:", reason);
    this[EVENT.DISCONNECTED](reason);
  }

  protected [EVENT.MESSAGE](event: string, payload: unknown) {
    this.emit("debug", `unhandled websocket event '${event}'`, payload);
  }

  protected abstract [EVENT.RECONNECTING](): void;
  protected abstract [EVENT.CONNECTING](): void;
  protected abstract [EVENT.CONNECTED](): void;
  protected abstract [EVENT.DISCONNECTED](reason?: Error): void;
  protected abstract [EVENT.TRACK](event: RTCTrackEvent): void;
  protected abstract [EVENT.DATA](data: unknown): void;
}
