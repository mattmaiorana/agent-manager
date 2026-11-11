
import type { IBufferCell, IBufferLine, IDisposable, ITheme, Terminal } from "@xterm/xterm";
import { GraphicsFilter, KittyGraphics, PLACEHOLDER, PLACEHOLDER_TEXT, diacriticValue, readPlaceholder, type PlaceholderCell, type StoredImage, type CellColors } from "./kitty";
import { blankPlaceholders, cellSize, unblankPlaceholders, underlineColor } from "./xterm-internals";

type Decoded = ImageBitmap | "pending" | "failed";

export interface FoundCell extends PlaceholderCell {
  x: number;
  y: number;
}

const EVENTS_KEPT = 400;
const DECODE_SETTLE_MS = 40;
const DECODES_AT_ONCE = 4;
const CLUSTER = new RegExp(`${PLACEHOLDER_TEXT}\\p{M}*`, "gu");

interface PictureRun { x0: number; x1: number; c: FoundCell; bmp: ImageBitmap; width: number; height: number; cols: number; rows: number }

export class PictureLayer {
  readonly filter: GraphicsFilter;
  readonly graphics: KittyGraphics;
  private decoded = new Map<StoredImage, Decoded>();
  private previous = new Map<number, { bmp: ImageBitmap; width: number; height: number }>();
  private disposed = false;
  private changedSinceSweep = true;

  bufferChanged(): void {
    this.changedSinceSweep = true;
    this.schedule();
  }
  private canvas: HTMLCanvasElement | null = null;
  private listeners: IDisposable[] = [];
  private frame = 0;
  private frameWin: Window | null = null;
  private sweepTimer = 0;
  private painted = false;
  readonly events: string[] = [];
  readonly opened: string[] = [];
  lastPaint: FoundCell[] = [];
  paints = 0;

  constructor(private term: Terminal, reply: (text: string) => void, filter?: GraphicsFilter) {
    this.filter = filter ?? new GraphicsFilter();
    this.graphics = new KittyGraphics({
      reply,
      inUse: (ids) => this.inUse(ids),
      dropped: (img, replaced) => {
        const d = this.decoded.get(img);
        this.decoded.delete(img);
        const ready = d && typeof d === "object" ? d : null;
        if (replaced) {
          if (ready) {
            this.forgetPrevious(img.id);
            this.previous.set(img.id, { bmp: ready, width: img.width, height: img.height });
          }
        } else {
          ready?.close();
          this.forgetPrevious(img.id);
        }
      },
      log: (e) => this.note(e),
      opened: (p) => {
        this.opened.push(p);
        if (this.opened.length > EVENTS_KEPT) this.opened.splice(0, this.opened.length - EVENTS_KEPT);
      },
    });
    this.listeners.push(
      term.onRender(() => this.paint()),
      term.onScroll(() => {
        this.changedSinceSweep = true;
      }),
      term.onResize(() => {
        this.changedSinceSweep = true;
      }),
    );
  }

  private note(e: string): void {
    this.events.push(e);
    if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
  }

  write(chunk: Uint8Array, done: () => void): void {
    this.changedSinceSweep = true;
    for (const piece of this.filter.push(chunk)) {
      if (piece.kind === "text") this.term.write(piece.bytes);
      else if (piece.kind === "graphics") {
        const body = piece.body;
        this.term.write("", () => {
          if (this.disposed) return;
          try {
            this.graphics.handle(body);
          } catch (e) {
            console.error("[vault-terminal] a picture command failed", e);
          }
          this.schedule();
        });
      } else {
        const why = piece.why;
        this.term.write("", () => {
          if (this.disposed) return;
          this.note(`cancelled: ${why}`);
          this.graphics.cancelled(why);
        });
      }
    }
    this.term.write("", done);
  }

  dispose(): void {
    this.disposed = true;
    for (const l of this.listeners) l.dispose();
    this.listeners = [];
    this.cancelFrame();
    if (this.sweepTimer) window.clearTimeout(this.sweepTimer);
    if (this.decodeTimer) window.clearTimeout(this.decodeTimer);
    this.graphics.clear();
    for (const id of [...this.previous.keys()]) this.forgetPrevious(id);
    this.canvas?.remove();
    this.canvas = null;
    unblankPlaceholders(this.term);
  }

  get surface(): HTMLCanvasElement | null {
    return this.canvas;
  }

  schedule(): void {
    if (this.frame) return;
    const win = this.term.element?.ownerDocument.defaultView;
    if (!win) return;
    this.frameWin = win;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private cancelFrame(): void {
    if (this.frame && this.frameWin) this.frameWin.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private cellsOn(line: IBufferLine, y: number, scratch?: IBufferCell, theme?: ITheme): (FoundCell & { bg: string })[] {
    const out: (FoundCell & { bg: string })[] = [];
    if (!line.translateToString(false).includes(PLACEHOLDER_TEXT)) return out;
    let left: ReturnType<typeof readPlaceholder> | null = null;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) break;
      const chars = cell.getChars();
      if (chars.codePointAt(0) !== PLACEHOLDER) {
        left = null;
        continue;
      }
      const marks: number[] = [];
      for (const ch of Array.from(chars).slice(1)) {
        const v = diacriticValue(ch.codePointAt(0)!);
        if (v === undefined) break;
        marks.push(v);
      }
      const colors: CellColors = { fg: cell.isFgDefault() ? -1 : cell.getFgColor(), underline: underlineColor(cell) ?? -1 };
      const ph = readPlaceholder(marks, colors, left);
      left = ph;
      out.push({ x, y, id: ph.id, placement: ph.placement, row: ph.row, col: ph.col, bg: theme ? background(cell, theme) : "" });
    }
    return out;
  }

  private inUse(ids: number[]): Set<number> {
    const want = new Set(ids);
    const shown = new Set<number>();
    for (const buf of [this.term.buffer.normal, this.term.buffer.alternate]) {
      for (let y = 0; y < buf.length && shown.size < want.size; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        for (const c of this.cellsOn(line, y)) if (want.has(c.id)) shown.add(c.id);
      }
    }
    return shown;
  }

  private forgetPrevious(id: number): void {
    this.previous.get(id)?.bmp.close();
    this.previous.delete(id);
  }

  private bitmap(img: StoredImage): ImageBitmap | null {
    const have = this.decoded.get(img);
    if (have !== undefined) return typeof have === "object" ? have : null;
    if (this.previous.has(img.id) && this.decoding < DECODES_AT_ONCE) {
      this.decode(img);
      return null;
    }
    this.wanted.add(img);
    if (!this.decodeTimer) this.decodeTimer = window.setTimeout(() => this.decodeWanted(), DECODE_SETTLE_MS);
    return null;
  }

  private wanted = new Set<StoredImage>();
  private decodeTimer = 0;
  private decoding = 0;

  private decodeWanted(): void {
    this.decodeTimer = 0;
    const onScreen = new Set(this.lastPaint.map((c) => c.id));
    for (const img of this.wanted) {
      if (this.decoding >= DECODES_AT_ONCE) break;
      this.wanted.delete(img);
      if (this.graphics.images.get(img.id) !== img || !onScreen.has(img.id) || this.decoded.has(img)) continue;
      this.decode(img);
    }
    this.wanted.clear();
  }

  private decode(img: StoredImage): void {
    this.decoded.set(img, "pending");
    this.decoding++;
    const win = this.term.element?.ownerDocument.defaultView ?? window;
    let made: Promise<ImageBitmap>;
    if (img.png) {
      const blob = new win.Blob([img.png as Uint8Array<ArrayBuffer>], { type: "image/png" });
      made = img.decode ? win.createImageBitmap(blob, { resizeWidth: img.decode.width, resizeHeight: img.decode.height, resizeQuality: "medium" }) : win.createImageBitmap(blob);
    }
    else {
      const px = new Uint8ClampedArray(img.width * img.height * 4);
      px.set(img.rgba!.subarray(0, px.length));
      made = win.createImageBitmap(new win.ImageData(px, img.width, img.height));
    }
    made.then(
      (bmp) => {
        this.decoding--;
        if (this.graphics.images.get(img.id) !== img) {
          bmp.close();
          return;
        }
        this.decoded.set(img, bmp);
        this.forgetPrevious(img.id);
        this.note(`decoded ${img.id}`);
        this.schedule();
      },
      (e) => {
        this.decoding--;
        if (this.graphics.images.get(img.id) !== img) return;
        this.forgetPrevious(img.id);
        this.decoded.set(img, "failed");
        this.graphics.failedToLoad(img);
        this.note(`couldn't decode ${img.id}: ${(e as Error)?.message ?? e}`);
        this.schedule();
      },
    );
  }

  paint(): void {
    const term = this.term;
    const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen || !this.filter.sawPlaceholder) {
      if (this.painted) this.clearCanvas();
      return;
    }
    const cell = cellSize(term);
    if (!cell) return;
    const blanked = blankPlaceholders(term, PLACEHOLDER_TEXT, CLUSTER);
    const doc = screen.ownerDocument;
    let canvas = this.canvas;
    if (!canvas || canvas.parentElement !== screen) {
      canvas?.remove();
      canvas = screen.createEl("canvas", { cls: "vault-terminal-pictures" });
      this.canvas = canvas;
    }
    const dpr = doc.defaultView?.devicePixelRatio ?? 1;
    const w = screen.clientWidth;
    const h = screen.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.paints++;
    const theme = term.options.theme ?? {};
    const buf = term.buffer.active;
    const found: FoundCell[] = [];
    const placed = new Set<number>();
    const scratch = buf.getNullCell();
    const px = (v: number) => Math.round(v * dpr);
    for (let r = 0; r < term.rows; r++) {
      const line = buf.getLine(buf.viewportY + r);
      if (!line) continue;
      const cells = this.cellsOn(line, r, scratch, theme);
      for (let i = 0; i < (blanked ? 0 : cells.length); i++) {
        const c = cells[i];
        if (cells[i + 1]?.x === c.x + 1) continue;
        const next = c.x + 1 < line.length ? line.getCell(c.x + 1, scratch) : undefined;
        if (!next || next.getChars().trim() !== "") continue;
        const nx0 = px((c.x + 1) * cell.width);
        ctx.fillStyle = background(next, theme);
        ctx.fillRect(nx0, px(r * cell.height), px((c.x + 2) * cell.width) - nx0, px((r + 1) * cell.height) - px(r * cell.height));
      }
      const at: { run: PictureRun | null } = { run: null };
      const flush = () => {
        const run = at.run;
        if (!run) return;
        const { c, bmp, width, height, cols, rows } = run;
        const boxW = cols * cell.width;
        const boxH = rows * cell.height;
        const scale = Math.min(boxW / width, boxH / height);
        const dw = width * scale;
        const dh = height * scale;
        const left = c.x * cell.width - c.col * cell.width + (boxW - dw) / 2;
        const top = r * cell.height - c.row * cell.height + (boxH - dh) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(run.x0, px(r * cell.height), run.x1 - run.x0, px((r + 1) * cell.height) - px(r * cell.height));
        ctx.clip();
        ctx.drawImage(bmp, left * dpr, top * dpr, dw * dpr, dh * dpr);
        ctx.restore();
        at.run = null;
      };
      for (const c of cells) {
        const x0 = px(c.x * cell.width);
        const y0 = px(r * cell.height);
        const x1 = px((c.x + 1) * cell.width);
        const y1 = px((r + 1) * cell.height);
        ctx.fillStyle = c.bg;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        found.push({ x: c.x, y: r, id: c.id, placement: c.placement, row: c.row, col: c.col });
        const img = this.graphics.images.get(c.id);
        const places = this.graphics.placements.get(c.id);
        const place = c.placement ? places?.get(c.placement) : places?.values().next().value;
        if (!img || !place) { flush(); continue; }
        placed.add(img.id);
        const ready = this.bitmap(img);
        const prev = ready ? null : this.previous.get(img.id);
        const bmp = ready ?? prev?.bmp;
        if (!bmp) { flush(); continue; }
        const width = prev?.width ?? img.width;
        const height = prev?.height ?? img.height;
        const cols = place.cols || Math.ceil(width / cell.width);
        const rows = place.rows || Math.ceil(height / cell.height);
        if (c.row >= rows || c.col >= cols) { flush(); continue; }
        this.graphics.touch(img);
        const r0 = at.run;
        if (r0 && r0.bmp === bmp && r0.c.row === c.row && r0.c.placement === c.placement && r0.c.id === c.id && x0 === r0.x1 && c.col - r0.c.col === c.x - r0.c.x) {
          r0.x1 = x1;
          continue;
        }
        flush();
        at.run = { x0, x1, c, bmp, width, height, cols, rows };
      }
      flush();
    }
    this.lastPaint = found;
    this.painted = found.length > 0;
    if (this.previous.size) for (const id of [...this.previous.keys()]) if (!placed.has(id)) this.forgetPrevious(id);
    if (this.graphics.pendingFree.size && !this.sweepTimer && this.changedSinceSweep) {
      this.sweepTimer = window.setTimeout(() => {
        this.sweepTimer = 0;
        this.changedSinceSweep = false;
        this.graphics.sweep();
      }, 1000);
    }
  }

  private clearCanvas(): void {
    const c = this.canvas;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    this.painted = false;
    this.lastPaint = [];
  }
}

const LEVELS = [0, 95, 135, 175, 215, 255];
const ANSI: (keyof ITheme)[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

export function paletteColor(index: number, theme: ITheme): string {
  if (index < 16) return (theme[ANSI[index]] as string | undefined) ?? "#000000";
  if (index < 232) {
    const k = index - 16;
    return hex((LEVELS[Math.floor(k / 36)] << 16) | (LEVELS[Math.floor(k / 6) % 6] << 8) | LEVELS[k % 6]);
  }
  const g = 8 + (index - 232) * 10;
  return hex((g << 16) | (g << 8) | g);
}

function background(cell: IBufferCell, theme: ITheme): string {
  if (cell.isBgRGB()) return hex(cell.getBgColor());
  if (cell.isBgPalette()) return paletteColor(cell.getBgColor(), theme);
  return theme.background ?? "#000000";
}
