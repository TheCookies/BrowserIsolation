/* Derived from m1k1o/neko client/src/neko/events.ts (Apache-2.0). Modified for Browser Isolation. */

export const EVENT = {
  RECONNECTING: "RECONNECTING",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  TRACK: "TRACK",
  MESSAGE: "MESSAGE",
  DATA: "DATA",

  SYSTEM: {
    INIT: "system/init",
    DISCONNECT: "system/disconnect",
    ERROR: "system/error",
  },
  CLIENT: {
    HEARTBEAT: "client/heartbeat",
  },
  SIGNAL: {
    OFFER: "signal/offer",
    ANSWER: "signal/answer",
    PROVIDE: "signal/provide",
    CANDIDATE: "signal/candidate",
  },
  MEMBER: {
    LIST: "member/list",
    CONNECTED: "member/connected",
    DISCONNECTED: "member/disconnected",
  },
  CONTROL: {
    LOCKED: "control/locked",
    RELEASE: "control/release",
    REQUEST: "control/request",
    REQUESTING: "control/requesting",
    CLIPBOARD: "control/clipboard",
    GIVE: "control/give",
    KEYBOARD: "control/keyboard",
  },
  FILETRANSFER: {
    LIST: "filetransfer/list",
    REFRESH: "filetransfer/refresh",
  },
  SCREEN: {
    CONFIGURATIONS: "screen/configurations",
    RESOLUTION: "screen/resolution",
    SET: "screen/set",
  },
} as const;

export type WebSocketEvents =
  | typeof EVENT.SYSTEM.INIT
  | typeof EVENT.SYSTEM.DISCONNECT
  | typeof EVENT.SYSTEM.ERROR
  | typeof EVENT.CLIENT.HEARTBEAT
  | typeof EVENT.CONTROL.LOCKED
  | typeof EVENT.CONTROL.RELEASE
  | typeof EVENT.CONTROL.REQUEST
  | typeof EVENT.CONTROL.GIVE
  | typeof EVENT.CONTROL.CLIPBOARD
  | typeof EVENT.CONTROL.KEYBOARD
  | typeof EVENT.FILETRANSFER.LIST
  | typeof EVENT.FILETRANSFER.REFRESH
  | typeof EVENT.MEMBER.LIST
  | typeof EVENT.MEMBER.CONNECTED
  | typeof EVENT.MEMBER.DISCONNECTED
  | typeof EVENT.SIGNAL.OFFER
  | typeof EVENT.SIGNAL.ANSWER
  | typeof EVENT.SIGNAL.PROVIDE
  | typeof EVENT.SIGNAL.CANDIDATE
  | typeof EVENT.SCREEN.CONFIGURATIONS
  | typeof EVENT.SCREEN.RESOLUTION
  | typeof EVENT.SCREEN.SET;
