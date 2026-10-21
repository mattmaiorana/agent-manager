// The few parts of xterm.js 6.0.0 that the terminal reaches past its public
// API for, each found in its source at the 6.0.0 tag (the package ships it),
// each checked before use. If a later xterm moves one, the accessor returns
// null and the caller falls back to xterm's own behavior; the self-test's
// "xterm internals are where expected" check fails so the move is noticed.
//
// - Mouse reports: xterm turns a mouse event into a report in whichever
//   protocol and encoding the program asked for (X10, SGR, SGR pixels, with
//   their restrictions). Sending wheel reports through the same function keeps
//   that exact, rather than tracking the program's mouse modes a second time.
// - The cell height in CSS pixels, which xterm measures from the font.
// - The viewport's scroll position: after a resize, xterm 6.0.0 can keep the
//   scroll bar's position from before (its issue #6172), and its public
//   scrollLines moves from there, so the next wheel event jumps. Scrolling
//   the buffer itself and resyncing the scroll bar to it avoids that.
// - A cell's underline color, as sent (SGR 58): kitty's placement id for a
//   picture's placeholder cell. The public IBufferCell has
//   no underline color; the object getCell returns is xterm's own CellData,
//   which does. xterm keeps the color only when the cell has an underline
//   style or a link (kitty.ts, PICTURE_LINK).

import type { IBufferCell, Terminal } from "@xterm/xterm";

interface MouseEvent {
  col: number;
  row: number;
  x: number;
  y: number;
  button: number;
  action: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

interface Core {
  coreMouseService?: { triggerMouseEvent?(e: MouseEvent): boolean };
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
  _viewport?: { _latestYDisp?: number; queueSync?(ydisp?: number): void };
  _bufferService?: { scrollLines?(disp: number, suppressScrollEvent?: boolean): void };
}

function core(term: Terminal): Core | null {
  const c = (term as unknown as { _core?: Core })._core;
  return c && typeof c === "object" ? c : null;
}

// CoreMouseButton.WHEEL, and CoreMouseAction.UP and DOWN, in xterm's common/Types.ts.
const WHEEL = 4;
const WHEEL_UP = 0;
const WHEEL_DOWN = 1;

/**
 * Sends one wheel report at a cell (0-based), in the program's own mouse
 * encoding, through xterm's input path (so it arrives as term.onData). False
 * if xterm wouldn't send it (the protocol has no wheel), null if the internals
 * have moved.
 */
export function sendWheelReport(term: Terminal, col: number, row: number, up: boolean, mods: { shift: boolean; alt: boolean; ctrl: boolean }, px: { x: number; y: number }): boolean | null {
  const service = core(term)?.coreMouseService;
  if (typeof service?.triggerMouseEvent !== "function") return null;
  // xterm sends the report as user input, which with scrollOnUserInput would
  // take a scrolled-up normal screen to the bottom; the wheel is no typing.
  const follows = term.options.scrollOnUserInput;
  term.options.scrollOnUserInput = false;
  try {
    return service.triggerMouseEvent({ col, row, x: px.x, y: px.y, button: WHEEL, action: up ? WHEEL_UP : WHEEL_DOWN, ...mods });
  } finally {
    term.options.scrollOnUserInput = follows;
  }
}

/** A cell's size in CSS pixels, as xterm measured it; null if not measured or moved. */
export function cellSize(term: Terminal): { width: number; height: number } | null {
  const cell = core(term)?._renderService?.dimensions?.css?.cell;
  return cell && cell.width > 0 && cell.height > 0 ? { width: cell.width, height: cell.height } : null;
}

/**
 * Puts the scroll bar back in step with the line at the top of the view, on
 * the next frame. Returns false if the internals have moved.
 */
export function resyncViewport(term: Terminal): boolean {
  const viewport = core(term)?._viewport;
  if (!viewport || typeof viewport.queueSync !== "function") return false;
  // xterm syncs to its last remembered line, which a resize leaves stale;
  // forgetting it makes the sync read the buffer's own.
  viewport._latestYDisp = undefined;
  viewport.queueSync();
  return true;
}

/**
 * Scrolls the view by lines from where the buffer says it is, not from the
 * scroll bar's position (which a resize can leave stale), then puts the
 * scroll bar in step. Falls back to xterm's public scrollLines.
 */
export function scrollBuffer(term: Terminal, lines: number): void {
  const buffer = core(term)?._bufferService;
  if (typeof buffer?.scrollLines !== "function" || !resyncViewport(term)) {
    term.scrollLines(lines);
    return;
  }
  buffer.scrollLines(lines);
  resyncViewport(term);
  // What xterm's own scrollLines does after scrolling; the DOM renderer
  // repaints anyway, other renderers might not.
  term.refresh(0, term.rows - 1);
}

interface CellInternals {
  hasExtendedAttrs?(): number;
  getUnderlineColor?(): number;
  extended?: { underlineColor: number; urlId?: number };
}

// Attributes.CM_MASK in xterm's common/buffer/Constants.ts: the color mode bits.
const CM_MASK = 0x3000000;

/**
 * A cell's underline color as sent: a 256-color index or a 24-bit value; -1
 * for none or the default; null if xterm's internals have moved.
 */
export function underlineColor(cell: IBufferCell): number | null {
  const c = cell as unknown as CellInternals;
  if (typeof c.hasExtendedAttrs !== "function" || typeof c.getUnderlineColor !== "function") return null;
  if (!c.hasExtendedAttrs()) return -1;
  const raw = c.extended?.underlineColor;
  if (typeof raw !== "number" || raw === -1 || (raw & CM_MASK) === 0) return -1;
  return c.getUnderlineColor();
}

/** The OSC 8 link a cell is in: xterm's id for it, 0 for none. For the self-test. */
export function linkIdOf(cell: IBufferCell): number {
  const c = cell as unknown as CellInternals;
  if (typeof c.hasExtendedAttrs !== "function" || !c.hasExtendedAttrs()) return 0;
  return c.extended?.urlId ?? 0;
}

/** Whether every internal above is where 6.0.0 has it. For the self-test. */
export function internalsPresent(term: Terminal): string[] {
  const c = core(term);
  const missing: string[] = [];
  if (typeof c?.coreMouseService?.triggerMouseEvent !== "function") missing.push("coreMouseService.triggerMouseEvent");
  if (!c?._renderService?.dimensions?.css?.cell) missing.push("_renderService.dimensions.css.cell");
  if (typeof c?._viewport?.queueSync !== "function") missing.push("_viewport.queueSync");
  if (typeof c?._bufferService?.scrollLines !== "function") missing.push("_bufferService.scrollLines");
  const cell = term.buffer.active.getLine(0)?.getCell(0) as unknown as CellInternals | undefined;
  if (typeof cell?.hasExtendedAttrs !== "function" || typeof cell.getUnderlineColor !== "function" || !cell.extended) missing.push("CellData underline color");
  return missing;
}
