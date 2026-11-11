
import type { IBufferCell, Terminal } from "@xterm/xterm";
import { linkPieces } from "./links";

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

interface RowFactory {
  createRow: (this: RowFactory, ...args: unknown[]) => HTMLSpanElement[];
}

interface Core {
  coreMouseService?: { triggerMouseEvent?(e: MouseEvent): boolean };
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } }; _renderer?: { value?: { _rowFactory?: RowFactory } } };
  _viewport?: { _latestYDisp?: number; queueSync?(ydisp?: number): void };
  _bufferService?: { scrollLines?(disp: number, suppressScrollEvent?: boolean): void };
}

function core(term: Terminal): Core | null {
  const c = (term as unknown as { _core?: Core })._core;
  return c && typeof c === "object" ? c : null;
}

const LEFT = 0;
const WHEEL = 4;
const WHEEL_UP = 0;
const WHEEL_DOWN = 1;
const BUTTON_UP = 0;
const BUTTON_DOWN = 1;
const BUTTON_MOVE = 32;

export function sendButtonReport(term: Terminal, col: number, row: number, action: "down" | "move" | "up", px: { x: number; y: number }): boolean | null {
  const service = core(term)?.coreMouseService;
  if (typeof service?.triggerMouseEvent !== "function") return null;
  const code = action === "down" ? BUTTON_DOWN : action === "move" ? BUTTON_MOVE : BUTTON_UP;
  return service.triggerMouseEvent({ col, row, x: px.x, y: px.y, button: LEFT, action: code, ctrl: false, alt: false, shift: false });
}

export function sendWheelReport(term: Terminal, col: number, row: number, up: boolean, mods: { shift: boolean; alt: boolean; ctrl: boolean }, px: { x: number; y: number }): boolean | null {
  const service = core(term)?.coreMouseService;
  if (typeof service?.triggerMouseEvent !== "function") return null;
  const follows = term.options.scrollOnUserInput;
  term.options.scrollOnUserInput = false;
  try {
    return service.triggerMouseEvent({ col, row, x: px.x, y: px.y, button: WHEEL, action: up ? WHEEL_UP : WHEEL_DOWN, ...mods });
  } finally {
    term.options.scrollOnUserInput = follows;
  }
}

export function cellSize(term: Terminal): { width: number; height: number } | null {
  const cell = core(term)?._renderService?.dimensions?.css?.cell;
  return cell && cell.width > 0 && cell.height > 0 ? { width: cell.width, height: cell.height } : null;
}

export function resyncViewport(term: Terminal): boolean {
  const viewport = core(term)?._viewport;
  if (!viewport || typeof viewport.queueSync !== "function") return false;
  viewport._latestYDisp = undefined;
  viewport.queueSync();
  return true;
}

export function scrollBuffer(term: Terminal, lines: number): void {
  const buffer = core(term)?._bufferService;
  if (typeof buffer?.scrollLines !== "function" || !resyncViewport(term)) {
    term.scrollLines(lines);
    return;
  }
  buffer.scrollLines(lines);
  resyncViewport(term);
  term.refresh(0, term.rows - 1);
}

interface CellInternals {
  hasExtendedAttrs?(): number;
  getUnderlineColor?(): number;
  extended?: { underlineColor: number; urlId?: number };
}

const CM_MASK = 0x3000000;

export function underlineColor(cell: IBufferCell): number | null {
  const c = cell as unknown as CellInternals;
  if (typeof c.hasExtendedAttrs !== "function" || typeof c.getUnderlineColor !== "function") return null;
  if (!c.hasExtendedAttrs()) return -1;
  const raw = c.extended?.underlineColor;
  if (typeof raw !== "number" || raw === -1 || (raw & CM_MASK) === 0) return -1;
  return c.getUnderlineColor();
}

export function linkIdOf(cell: IBufferCell): number {
  const c = cell as unknown as CellInternals;
  if (typeof c.hasExtendedAttrs !== "function" || !c.hasExtendedAttrs()) return 0;
  return c.extended?.urlId ?? 0;
}

function rowFactory(term: Terminal): RowFactory | null {
  const f = core(term)?._renderService?._renderer?.value?._rowFactory;
  return f && typeof f.createRow === "function" ? f : null;
}

interface RowHook {
  blank?: { placeholder: string; cluster: RegExp };
  links?: (row: number) => readonly (readonly [number, number])[];
}
const hooks = new WeakMap<RowFactory, RowHook>();
const unexpected = new WeakSet<RowFactory>();

interface WidthCache {
  get(c: string, bold: boolean, italic: boolean): number;
}

interface RowLine {
  length: number;
  getWidth(x: number): number;
  getString(x: number): string;
}

const isRowLine = (v: unknown): v is RowLine => {
  const l = v as Partial<RowLine> | null;
  return !!l && typeof l.length === "number" && typeof l.getWidth === "function" && typeof l.getString === "function";
};

function hookRows(term: Terminal): { factory: RowFactory; hook: RowHook } | null {
  const factory = rowFactory(term);
  if (!factory || unexpected.has(factory)) return null;
  let hook = hooks.get(factory);
  if (hook) return { factory, hook };
  hook = {};
  hooks.set(factory, hook);
  const create = (Object.getPrototypeOf(factory) as RowFactory).createRow;
  factory.createRow = function (this: RowFactory, ...args: unknown[]): HTMLSpanElement[] {
    const widths = args[8] as Partial<WidthCache> | undefined;
    const own = hooks.get(this);
    if (!own || typeof args[1] !== "number" || !isRowLine(args[0]) || typeof args[7] !== "number" || typeof widths?.get !== "function") {
      unexpected.add(this);
      delete (this as Partial<RowFactory>).createRow;
      hooks.delete(this);
      return create.apply(this, args);
    }
    const blank = own.blank;
    if (blank) {
      const cache = widths as WidthCache;
      args[8] = { get: (c: string, bold: boolean, italic: boolean) => cache.get(c.startsWith(blank.placeholder) ? " " : c, bold, italic) };
    }
    let spans = create.apply(this, args);
    const links = own.links?.(args[1]);
    if (links?.length) spans = underlineSpans(spans, args[0], links);
    if (blank) {
      for (const span of spans) {
        const text = span.textContent;
        if (!text || !text.includes(blank.placeholder)) continue;
        const blanked = text.replace(blank.cluster, " ");
        span.textContent = blanked;
        if (!blanked.trim()) span.classList.add("vault-terminal-placeholder");
      }
    }
    return spans;
  };
  return { factory, hook };
}

function unhookIfIdle(factory: RowFactory, hook: RowHook): void {
  if (hook.blank || hook.links) return;
  delete (factory as Partial<RowFactory>).createRow;
  hooks.delete(factory);
}

function underlineSpans(spans: HTMLSpanElement[], line: RowLine, links: readonly (readonly [number, number])[]): HTMLSpanElement[] {
  const columns: number[] = [];
  let expected = "";
  for (let x = 0; x < line.length; x++) {
    if (line.getWidth(x) === 0) continue;
    const chars = line.getString(x) || " ";
    expected += chars;
    for (let i = 0; i < chars.length; i++) columns.push(x);
  }
  const texts = spans.map((s) => s.textContent ?? "");
  if (!expected.startsWith(texts.join("").replace(/\u00a0/g, " "))) return spans;
  const pieces = linkPieces(texts, columns, links);
  if (!pieces) return spans;
  const out: HTMLSpanElement[] = [];
  spans.forEach((span, i) => {
    const parts = pieces[i];
    const underlined = [...span.classList].some((c) => c.startsWith("xterm-underline-"));
    if (underlined || !parts.some((p) => p.link)) return void out.push(span);
    const plain = ![...span.classList].some((c) => c.startsWith("xterm-fg-")) && !span.style.color;
    for (const part of parts) {
      const piece = span.cloneNode(false) as HTMLSpanElement;
      piece.textContent = part.text;
      if (part.link) piece.classList.add("xterm-underline-1", "vault-terminal-link");
      if (part.link && plain) piece.classList.add("vault-terminal-link-plain");
      out.push(piece);
    }
  });
  return out;
}

export function blankPlaceholders(term: Terminal, placeholder: string, cluster: RegExp): boolean {
  const hooked = hookRows(term);
  if (!hooked) return false;
  if (hooked.hook.blank) return true;
  hooked.hook.blank = { placeholder, cluster };
  term.refresh(0, term.rows - 1);
  return false;
}

export function unblankPlaceholders(term: Terminal): void {
  const factory = rowFactory(term);
  const hook = factory && hooks.get(factory);
  if (!factory || !hook?.blank) return;
  hook.blank = undefined;
  unhookIfIdle(factory, hook);
}

export function underlineLinks(term: Terminal, links: (row: number) => readonly (readonly [number, number])[]): boolean {
  const hooked = hookRows(term);
  if (!hooked) return false;
  if (hooked.hook.links === links) return true;
  hooked.hook.links = links;
  term.refresh(0, term.rows - 1);
  return true;
}

export function stopUnderliningLinks(term: Terminal): void {
  const factory = rowFactory(term);
  const hook = factory && hooks.get(factory);
  if (!factory || !hook?.links) return;
  hook.links = undefined;
  unhookIfIdle(factory, hook);
  term.refresh(0, term.rows - 1);
}

export function internalsPresent(term: Terminal): string[] {
  const c = core(term);
  const missing: string[] = [];
  if (typeof c?.coreMouseService?.triggerMouseEvent !== "function") missing.push("coreMouseService.triggerMouseEvent");
  if (!c?._renderService?.dimensions?.css?.cell) missing.push("_renderService.dimensions.css.cell");
  if (typeof c?._viewport?.queueSync !== "function") missing.push("_viewport.queueSync");
  if (typeof c?._bufferService?.scrollLines !== "function") missing.push("_bufferService.scrollLines");
  if (!rowFactory(term)) missing.push("_renderService._renderer.value._rowFactory.createRow");
  const cell = term.buffer.active.getLine(0)?.getCell(0) as unknown as CellInternals | undefined;
  if (typeof cell?.hasExtendedAttrs !== "function" || typeof cell.getUnderlineColor !== "function" || !cell.extended) missing.push("CellData underline color");
  return missing;
}
