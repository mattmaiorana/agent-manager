
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function ctrlCCopies(e: KeyLike, hasSelection: boolean, alwaysInterrupts: boolean): boolean {
  const ctrlC = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c";
  return ctrlC && hasSelection && !alwaysInterrupts;
}

export type AfterExit = "restart" | "shell" | "nothing";

export function afterExitKey(data: string, hosted: boolean): AfterExit {
  if (data === "\r") return "restart";
  if (!hosted && data.toLowerCase() === "s") return "shell";
  return "nothing";
}

export function typesCharacter(e: KeyLike, optionIsMeta: boolean): boolean {
  if (e.ctrlKey || e.metaKey || (e.altKey && optionIsMeta)) return false;
  return [...e.key].length === 1;
}

export interface Cell {
  col: number;
  row: number;
}

export function selectsInBox(down: Cell, up: Cell, clicks: number, box: { top: number; bottom: number } | null): boolean {
  if (!box) return false;
  const inside = (row: number) => row > box.top && row < box.bottom;
  if (!inside(down.row) || !inside(up.row)) return false;
  return clicks >= 2 || down.row !== up.row || down.col !== up.col;
}

export interface Gesture {
  from: Cell;
  to: Cell;
  clicks: number;
  whole: boolean;
  keys?: SelectMove[];
  focus?: Cell | null;
  top?: number;
}

export type SelectMove = "left" | "right" | "up" | "down" | "lineStart" | "lineEnd";

export function selectMove(e: KeyLike): SelectMove | null {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  const keys: Record<string, SelectMove> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  return keys[e.key] ?? null;
}

export const SELECT_MOVE_KEYS: Record<SelectMove, string> = {
  left: "\x1b[1;2D",
  right: "\x1b[1;2C",
  up: "\x1b[1;2A",
  down: "\x1b[1;2B",
  lineStart: "\x1b[1;2H",
  lineEnd: "\x1b[1;2F",
};

export interface TextArea {
  first: number;
  last: number;
  x1: number;
  cols: number;
  limits: number[];
  empty: boolean;
}

export function compareCells(a: Cell, b: Cell): number {
  return a.row !== b.row ? a.row - b.row : a.col - b.col;
}

function textEnd(area: TextArea): Cell {
  return { col: area.limits[area.last - area.first] ?? area.x1, row: area.last };
}

function limit(area: TextArea, row: number): number {
  return area.limits[row - area.first] ?? area.x1;
}

function onText(f: Cell, area: TextArea): Cell {
  const row = Math.max(area.first, Math.min(area.last, f.row));
  if (f.col < area.x1 && row > area.first) return { col: limit(area, row - 1), row: row - 1 };
  return { col: Math.max(area.x1, Math.min(limit(area, row), f.col)), row };
}

export function textMove(f: Cell, move: SelectMove, area: TextArea): Cell {
  const at = onText(f, area);
  const { first, last, x1 } = area;
  switch (move) {
    case "left":
      if (at.col > x1) return { col: at.col - 1, row: at.row };
      return at.row > first ? { col: limit(area, at.row - 1), row: at.row - 1 } : at;
    case "right":
      if (at.col < limit(area, at.row)) return { col: at.col + 1, row: at.row };
      return at.row < last ? { col: x1, row: at.row + 1 } : at;
    case "up":
      return at.row > first ? { col: Math.min(Math.max(x1, f.col), limit(area, at.row - 1)), row: at.row - 1 } : { col: x1, row: first };
    case "down":
      return at.row < last ? { col: Math.min(Math.max(x1, f.col), limit(area, at.row + 1)), row: at.row + 1 } : { col: limit(area, last), row: last };
    case "lineStart":
      return { col: x1, row: at.row };
    case "lineEnd":
      return { col: limit(area, at.row), row: at.row };
  }
}

export function movesTo(from: Cell, to: Cell, cols: number): SelectMove[] {
  const rows = to.row - from.row;
  const moves: SelectMove[] = Array<SelectMove>(Math.abs(rows)).fill(rows < 0 ? "up" : "down");
  const step = (n: number): SelectMove[] => Array<SelectMove>(Math.abs(n)).fill(n < 0 ? "left" : "right");
  const direct = step(to.col - from.col);
  const viaStart: SelectMove[] = ["lineStart", ...step(to.col)];
  const viaEnd: SelectMove[] = ["lineEnd", ...step(to.col - (cols - 1))];
  const cols3 = [direct, viaStart, viaEnd].sort((a, b) => a.length - b.length)[0] ?? direct;
  return [...moves, ...cols3];
}

export function dragSelection(anchor: Cell, focus: Cell, cols: number): Gesture {
  if (compareCells(anchor, focus) !== 0) return { from: anchor, to: focus, clicks: 1, whole: false, focus };
  const edge = anchor.col >= cols - 1;
  return { from: anchor, to: { col: anchor.col + (edge ? -1 : 1), row: anchor.row }, clicks: 1, whole: false, keys: [edge ? "right" : "left"], focus };
}

export function startSelection(move: SelectMove, caret: Cell, area: TextArea): Gesture | null {
  if (area.empty) return null;
  const forward = move === "right" || move === "down" || move === "lineEnd";
  const end = textEnd(area);
  if (forward) {
    if (compareCells(caret, end) > 0) return null;
    const lands = textMove(caret, move, area);
    const focus = move === "right" || compareCells(lands, caret) <= 0 ? caret : lands.col === limit(area, lands.row) ? lands : textMove(lands, "left", area);
    return dragSelection(caret, compareCells(focus, caret) < 0 ? caret : focus, area.cols);
  }
  if (caret.row <= area.first && caret.col <= area.x1) return null;
  const anchor = compareCells(caret, end) > 0 ? end : textMove(caret, "left", area);
  const lands = move === "left" ? anchor : textMove(caret, move, area);
  return dragSelection(anchor, compareCells(lands, anchor) > 0 ? anchor : lands, area.cols);
}

export interface InputRow {
  end: number;
  nextWord: number;
  oneWord: boolean;
}

export function rowBreaks(rows: InputRow[], cols: number): string[] {
  return rows.map((r) => (r.end + 1 + r.nextWord <= cols - 5 ? "\n" : r.oneWord ? "" : " "));
}

export function unwrapCopy(text: string, breaks: string[], indent: number): string {
  const lines = text.split("\n");
  if (lines.length !== breaks.length + 1) return text;
  const pad = " ".repeat(indent);
  return lines.map((line, i) => (i > 0 && line.startsWith(pad) ? line.slice(indent) : line)).reduce((all, line, i) => all + (breaks[i - 1] ?? "") + line);
}

export function dedentCopy(text: string): string {
  const lines = text.split("\n");
  const lead = (l: string) => l.length - l.trimStart().length;
  const rest = lines.slice(1).filter((l) => l.trim());
  const indent = rest.length ? Math.min(...rest.map(lead)) : lead(lines[0]);
  if (!indent) return text;
  return lines.map((l) => l.slice(Math.min(indent, lead(l)))).join("\n");
}

export function gestureFocus(g: Gesture): Cell | null {
  if (g.focus !== undefined) return g.focus;
  return g.clicks < 2 ? g.to : null;
}

export function gestureReports(g: Gesture): { at: Cell; action: "down" | "move" | "up" }[] {
  if (g.clicks < 2) return [{ at: g.from, action: "down" }, { at: g.to, action: "move" }, { at: g.to, action: "up" }];
  const pair: { at: Cell; action: "down" | "up" }[] = [{ at: g.to, action: "down" }, { at: g.to, action: "up" }];
  return Array.from({ length: Math.min(3, g.clicks) }, () => pair).flat();
}

export const CLAUDE_MULTI_CLICK_MS = 500;
export const CLAUDE_MULTI_CLICK_CELLS = 1;
const CLICK_MARGIN_MS = 150;

export function replayPlan(g: Gesture, lastPress: Cell & { at: number }, now: number, wordChar: (col: number) => boolean): { gesture: Gesture; wait: number } {
  const near = (c: Cell) => Math.abs(c.col - lastPress.col) <= CLAUDE_MULTI_CLICK_CELLS && Math.abs(c.row - lastPress.row) <= CLAUDE_MULTI_CLICK_CELLS;
  const left = Math.max(0, lastPress.at + CLAUDE_MULTI_CLICK_MS + CLICK_MARGIN_MS - now);
  if (g.clicks >= 3) return { gesture: g, wait: 0 };
  if (g.clicks === 2) {
    if (lastPress.row === g.to.row) {
      for (const d of [2, -2, 3, -3]) {
        const col = lastPress.col + d;
        const lo = Math.min(col, g.to.col, lastPress.col);
        const hi = Math.max(col, g.to.col, lastPress.col);
        let inWord = lo >= 0;
        for (let c = lo; inWord && c <= hi; c++) inWord = wordChar(c);
        if (inWord) {
          const at = { col, row: g.to.row };
          return { gesture: { ...g, from: at, to: at }, wait: 0 };
        }
      }
    }
    return { gesture: g, wait: near(g.to) ? left : 0 };
  }
  return { gesture: g, wait: near(g.from) ? left : 0 };
}

export type QueueItem = string | (() => void) | { wait: number } | QueueHold;
export interface QueueHold {
  hold: (done: (go: boolean) => boolean) => void;
  then: QueueItem[];
}

export class KeyQueue {
  private items: QueueItem[] = [];
  private timer: unknown = null;
  private stepping = false;
  private holding = false;
  private cleared = 0;

  constructor(
    private readonly send: (data: string) => void,
    private readonly schedule: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (timer: unknown) => void,
    private readonly gap: number,
  ) {}

  get busy(): boolean {
    return this.timer !== null || this.items.length > 0 || this.stepping || this.holding;
  }

  push(...items: QueueItem[]): void {
    this.items.push(...items);
    if (this.timer === null && !this.stepping && !this.holding) this.step();
  }

  clear(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.items = [];
    this.holding = false;
    this.cleared++;
  }

  private step(): void {
    this.timer = null;
    const item = this.items.shift();
    if (item === undefined) return;
    const cleared = this.cleared;
    let wait = this.gap;
    this.stepping = true;
    try {
      if (typeof item === "function") item();
      else if (typeof item === "string") this.send(item);
      else if ("wait" in item) wait = item.wait;
      else return this.hold(item, cleared);
    } finally {
      this.stepping = false;
    }
    if (this.cleared !== cleared) return;
    this.timer = this.schedule(() => this.step(), wait);
  }

  private hold(item: QueueHold, cleared: number): void {
    this.holding = true;
    item.hold((go) => {
      if (!this.holding || this.cleared !== cleared) return false;
      this.holding = false;
      if (go) this.items.unshift(...item.then);
      this.timer = this.schedule(() => this.step(), 0);
      return true;
    });
  }
}
