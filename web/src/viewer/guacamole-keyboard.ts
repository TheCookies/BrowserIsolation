/* Thin TypeScript wrapper around Apache Guacamole Keyboard (Apache-2.0).
 * Adapted from m1k1o/neko client/src/utils/guacamole-keyboard.ts. */

import GuacamoleKeyboardCtor from "./guacamole-keyboard.impl.js";

export type GuacamoleKeyboardInterface = {
  onkeydown?: (keysym: number) => boolean;
  onkeyup?: (keysym: number) => void;
  press: (keysym: number) => boolean;
  release: (keysym: number) => void;
  type: (str: string) => void;
  reset: () => void;
  listenTo: (element: Element | Document) => void;
};

export default function createGuacamoleKeyboard(element?: Element): GuacamoleKeyboardInterface {
  const keyboard = {} as GuacamoleKeyboardInterface;
  // Guacamole.Keyboard is a constructor that assigns methods onto `this`.
  GuacamoleKeyboardCtor.bind(keyboard, element)();
  return keyboard;
}
