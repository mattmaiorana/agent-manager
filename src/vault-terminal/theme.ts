// Terminal colors and font from Obsidian's theme, read from the terminal's own
// element so a popout uses its own document. Obsidian's variables may hold any
// CSS color (hsl(), color-mix()), so each is resolved through a canvas into a
// hex value xterm can use.

import type { ITheme } from "@xterm/xterm";

const canvases = new WeakMap<Document, CanvasRenderingContext2D | null>();

function context(doc: Document): CanvasRenderingContext2D | null {
  if (!canvases.has(doc)) {
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvases.set(doc, canvas.getContext("2d", { willReadFrequently: true }));
  }
  return canvases.get(doc) ?? null;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Resolves any CSS color to #rrggbb or #rrggbbaa, or undefined if it isn't one. */
export function toHex(doc: Document, color: string): string | undefined {
  const value = color.trim();
  if (!value) return undefined;
  const ctx = context(doc);
  if (!ctx) return undefined;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#00000000";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

function luminance(h: string): number {
  const n = parseInt(h.slice(1, 7), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

export interface TerminalLook {
  theme: ITheme;
  fontFamily: string;
}

export function readLook(el: HTMLElement): TerminalLook {
  const doc = el.ownerDocument;
  const style = (doc.defaultView ?? window).getComputedStyle(el);
  const v = (name: string, fallback: string) => toHex(doc, style.getPropertyValue(name)) ?? fallback;

  // The pane's own background, so a sidebar terminal matches the sidebar.
  let background: string | undefined;
  for (let node: HTMLElement | null = el; node && !background; node = node.parentElement) {
    const bg = toHex(doc, (doc.defaultView ?? window).getComputedStyle(node).backgroundColor);
    if (bg && bg.length === 7) background = bg;
  }
  background ??= v("--background-primary", "#1e1e1e");
  const foreground = v("--text-normal", "#dcddde");
  const base00 = v("--color-base-00", "#1e1e1e");
  const base100 = v("--color-base-100", "#dadada");
  const [dark, light] = luminance(base00) < luminance(base100) ? [base00, base100] : [base100, base00];
  const red = v("--color-red", "#e93147");
  const green = v("--color-green", "#08b94e");
  const yellow = v("--color-yellow", "#e0ac00");
  const blue = v("--color-blue", "#086ddd");
  const magenta = v("--color-purple", "#7852ee");
  const cyan = v("--color-cyan", "#00bfbc");

  const theme: ITheme = {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: v("--text-selection", "#4a90d966"),
    black: dark,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: v("--text-muted", "#b3b3b3"),
    brightBlack: v("--text-faint", "#666666"),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: light,
  };
  const fontFamily = style.getPropertyValue("--font-monospace").trim() || "Menlo, monospace";
  return { theme, fontFamily };
}
