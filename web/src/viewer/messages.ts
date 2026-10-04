/* Derived from m1k1o/neko client/src/neko/messages.ts (Apache-2.0). Modified for Browser Isolation. */

import { EVENT, type WebSocketEvents } from "./events";
import type { ScreenResolution } from "./types";

export type WebSocketMessages =
  | WebSocketMessage
  | SignalProvideMessage
  | SignalOfferMessage
  | SignalAnswerMessage
  | SignalCandidateMessage
  | ScreenResolutionMessage
  | SystemInitMessage
  | ControlClipboardMessage
  | FileTransferListMessage;

export type WebSocketPayloads =
  | SignalProvidePayload
  | SignalOfferPayload
  | SignalAnswerPayload
  | SignalCandidatePayload
  | ControlKeyboardPayload
  | ControlClipboardPayload
  | ScreenResolutionPayload;

export type WebSocketMessage = {
  event: WebSocketEvents | string;
};

export type SystemInitMessage = WebSocketMessage &
  SystemInitPayload & {
    event: typeof EVENT.SYSTEM.INIT;
  };

export type SystemInitPayload = {
  implicit_hosting: boolean;
  locks: Record<string, string>;
  file_transfer: boolean;
  heartbeat_interval: number;
};

export type SignalProvideMessage = WebSocketMessage &
  SignalProvidePayload & {
    event: typeof EVENT.SIGNAL.PROVIDE;
  };

export type SignalProvidePayload = {
  id: string;
  lite: boolean;
  ice: RTCIceServer[];
  sdp: string;
};

export type SignalOfferMessage = WebSocketMessage &
  SignalOfferPayload & {
    event: typeof EVENT.SIGNAL.OFFER;
  };

export type SignalOfferPayload = {
  sdp: string;
};

export type SignalAnswerMessage = WebSocketMessage &
  SignalAnswerPayload & {
    event: typeof EVENT.SIGNAL.ANSWER;
  };

export type SignalAnswerPayload = {
  sdp: string;
  displayname: string;
};

export type SignalCandidateMessage = WebSocketMessage &
  SignalCandidatePayload & {
    event: typeof EVENT.SIGNAL.CANDIDATE;
  };

export type SignalCandidatePayload = {
  data: string;
};

export type ControlKeyboardPayload = {
  layout?: string;
  capsLock?: boolean;
  numLock?: boolean;
  scrollLock?: boolean;
};

export type ControlClipboardPayload = {
  text: string;
};

export type ControlClipboardMessage = WebSocketMessage &
  ControlClipboardPayload & {
    event: typeof EVENT.CONTROL.CLIPBOARD;
  };

export type FileTransferItem = {
  name: string;
  size: number;
};

export type FileTransferListPayload = {
  cwd?: string;
  files: FileTransferItem[];
};

export type FileTransferListMessage = WebSocketMessage &
  FileTransferListPayload & {
    event: typeof EVENT.FILETRANSFER.LIST;
  };

export type ScreenResolutionMessage = WebSocketMessage &
  ScreenResolutionPayload & {
    event: typeof EVENT.SCREEN.RESOLUTION;
  };

export type ScreenResolutionPayload = ScreenResolution & {
  id?: string;
};
