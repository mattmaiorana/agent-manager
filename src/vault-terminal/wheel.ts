// How far a wheel event moves a terminal, in lines. No
// Obsidian or xterm code here, so test/harness.ts can check it.
//
// One line per cell height of travel, the same for a shell's scrollback, a
// full-screen program's scroll reports, and the arrow keys a full-screen
// program without the mouse gets: so the same gesture moves each the same
// distance. Travel left over is carried to the next event in the same
// direction and dropped when the direction changes. At most one screen per
// event; travel past that is dropped, not carried, so a flick never runs on.
// xterm 6.0.0 instead sends one report per event whatever its distance, and
// scales trackpad events under 50 px by 0.3 first.

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

export interface WheelInput {
  deltaY: number;
  deltaX: number;
  deltaMode: number;
  shiftKey: boolean;
}

/** The vertical travel in an event, in its own units: macOS turns Shift with a mouse wheel into sideways travel. */
export function verticalDelta(ev: WheelInput): number {
  if (ev.deltaY) return ev.deltaY;
  return ev.shiftKey ? ev.deltaX : 0;
}

/** The "Scroll speed" setting, lines per line of travel, clamped to 0.25 to 4 (1 when unset). */
export function scrollSpeed(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(4, Math.max(0.25, v)) : 1;
}

export class WheelCounter {
  /** Travel not yet turned into a line, in pixels; its sign is its direction. */
  private carry = 0;

  /**
   * Lines to move for one event: positive is down (later output), negative
   * up. cellHeight is the row height in CSS pixels; rows, the screen's.
   * scale multiplies the travel (the scroll speed setting; 1 by default).
   */
  lines(ev: WheelInput, cellHeight: number, rows: number, scale = 1): number {
    const delta = verticalDelta(ev);
    if (!delta || !(cellHeight > 0) || !(rows > 0) || !(scale > 0)) return 0;
    const unscaled = ev.deltaMode === DOM_DELTA_LINE ? delta * cellHeight : ev.deltaMode === DOM_DELTA_PAGE ? delta * rows * cellHeight : delta;
    const px = unscaled * scale;
    if (this.carry && Math.sign(this.carry) !== Math.sign(px)) this.carry = 0;
    const travel = this.carry + px;
    // The epsilon keeps 3 × a fractional cell height from coming out as 2.9999.
    const n = Math.trunc(travel / cellHeight + Math.sign(travel) * 1e-9);
    if (Math.abs(n) >= rows) {
      this.carry = 0;
      return Math.sign(n) * rows;
    }
    this.carry = travel - n * cellHeight;
    return n;
  }

  reset(): void {
    this.carry = 0;
  }
}

/**
 * The least time between scroll reports sent, in ms. A full-screen program
 * redraws for reports as they come, and claude merges the ones that land
 * between its frames (at least 16 ms apart) into one jump of several rows;
 * one report at a time, a frame apart, moves its view a row at a time.
 */
export const REPORT_GAP_MS = 15;

/**
 * Reports to send at once from a queue of n lines: one while the queue is
 * short, so a mouse notch's three lines go out over three frames; more
 * when it's long, so a fast turn of the wheel keeps up.
 */
export function drainCount(n: number): number {
  const a = Math.abs(n);
  if (a === 0) return 0;
  if (a <= 3) return 1;
  if (a <= 8) return 2;
  return Math.ceil(a / 4);
}

/**
 * Scroll reports waiting to go to a full-screen program, sent no closer
 * together than REPORT_GAP_MS (drainCount at a time). The queue holds at
 * most a screen and is emptied when the direction changes, so the view
 * stops when the wheel stops.
 */
export class ReportQueue {
  /** Lines waiting; the sign is the direction, as WheelCounter's. */
  private pending = 0;
  private lastSent = -Infinity;

  add(lines: number, rows: number): void {
    if (!lines || !(rows > 0)) return;
    if (this.pending && Math.sign(this.pending) !== Math.sign(lines)) this.pending = 0;
    this.pending = Math.max(-rows, Math.min(rows, this.pending + lines));
  }

  /** Lines to send now (signed), or 0 if it's too soon or nothing waits. */
  take(now: number): number {
    if (!this.pending || now - this.lastSent < REPORT_GAP_MS) return 0;
    const n = drainCount(this.pending) * Math.sign(this.pending);
    this.pending -= n;
    this.lastSent = now;
    return n;
  }

  get waiting(): boolean {
    return this.pending !== 0;
  }

  clear(): void {
    this.pending = 0;
  }
}
