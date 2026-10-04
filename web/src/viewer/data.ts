/* Derived from m1k1o/neko client/src/neko/data.ts (Apache-2.0). Modified for Browser Isolation. */

export const OPCODE = {
  MOVE: 0x01,
  SCROLL: 0x02,
  KEY_DOWN: 0x03,
  KEY_UP: 0x04,
} as const;
