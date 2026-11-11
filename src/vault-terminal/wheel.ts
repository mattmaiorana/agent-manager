
export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

export interface WheelInput {
  deltaY: number;
  deltaX: number;
  deltaMode: number;
  shiftKey: boolean;
}

export function verticalDelta(ev: WheelInput): number {
  if (ev.deltaY) return ev.deltaY;
  return ev.shiftKey ? ev.deltaX : 0;
}

export function scrollSpeed(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(4, Math.max(0.25, v)) : 1;
}

export class WheelCounter {
  private carry = 0;

  lines(ev: WheelInput, cellHeight: number, rows: number, scale = 1): number {
    const delta = verticalDelta(ev);
    if (!delta || !(cellHeight > 0) || !(rows > 0) || !(scale > 0)) return 0;
    const unscaled = ev.deltaMode === DOM_DELTA_LINE ? delta * cellHeight : ev.deltaMode === DOM_DELTA_PAGE ? delta * rows * cellHeight : delta;
    const px = unscaled * scale;
    if (this.carry && Math.sign(this.carry) !== Math.sign(px)) this.carry = 0;
    const travel = this.carry + px;
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

export const REPORT_GAP_MS = 15;

export function drainCount(n: number): number {
  const a = Math.abs(n);
  if (a === 0) return 0;
  if (a <= 3) return 1;
  if (a <= 8) return 2;
  return Math.ceil(a / 4);
}

export class ReportQueue {
  private pending = 0;
  private lastSent = -Infinity;

  add(lines: number, rows: number): void {
    if (!lines || !(rows > 0)) return;
    if (this.pending && Math.sign(this.pending) !== Math.sign(lines)) this.pending = 0;
    this.pending = Math.max(-rows, Math.min(rows, this.pending + lines));
  }

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
