// Small decisions about keys, kept free of Obsidian and xterm so
// test/harness.ts can check them.

/** The parts of a key event these decisions read. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether Ctrl+C copies the terminal's selection instead of going to the
 * program as the interrupt (a setting, off by default).
 * Off ("Ctrl+C always interrupts" unset), Ctrl+C copies only when the
 * terminal has a selection of its own, and otherwise interrupts. On, it
 * always interrupts. Never the program's copy (Super+C): with nothing
 * selected, Ctrl+C must stay the way to interrupt Claude.
 */
export function ctrlCCopies(e: KeyLike, hasSelection: boolean, alwaysInterrupts: boolean): boolean {
  const ctrlC = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c";
  return ctrlC && hasSelection && !alwaysInterrupts;
}

/** What a key typed after the program ended does. */
export type AfterExit = "restart" | "shell" | "nothing";

/**
 * After the program ends, Enter starts it again and S starts a shell. A
 * terminal a host controls never gets the shell (a session tab with its
 * strip and controls would be holding a shell instead), and its Enter goes
 * to the host, which may refuse it.
 */
export function afterExitKey(data: string, hosted: boolean): AfterExit {
  if (data === "\r") return "restart";
  if (!hosted && data.toLowerCase() === "s") return "shell";
  return "nothing";
}

/**
 * Whether a key types a character (a letter, a digit, a symbol, Space): what
 * replaces a selection in claude's input, as typing does in a text field.
 * Never with Ctrl or Cmd, and never with Option while it acts as Meta (then
 * it's a shortcut, Option+B a word back). Enter, Tab and the arrows have
 * names, not characters, so they never count.
 */
export function typesCharacter(e: KeyLike, optionIsMeta: boolean): boolean {
  if (e.ctrlKey || e.metaKey || (e.altKey && optionIsMeta)) return false;
  return [...e.key].length === 1;
}

/** A cell of the buffer: its column and its row (0-based, the buffer's rows, not the screen's). */
export interface Cell {
  col: number;
  row: number;
}

/**
 * Whether a press and release of the left button leave claude's own selection
 * (its full screen, which has the mouse) in its input box: a drag that starts
 * and ends inside the box, or a double click (a word) or triple click (a line)
 * in it. A single click without moving selects nothing. `box`: the rows of the
 * box's two borders, null when there's no box (a dialog, say). `clicks`: the
 * release's click count (MouseEvent.detail).
 */
export function selectsInBox(down: Cell, up: Cell, clicks: number, box: { top: number; bottom: number } | null): boolean {
  if (!box) return false;
  const inside = (row: number) => row > box.top && row < box.bottom;
  if (!inside(down.row) || !inside(up.row)) return false;
  return clicks >= 2 || down.row !== up.row || down.col !== up.col;
}

/**
 * How claude's own selection in its input was made, so it can be made again
 * after a copy, which clears it: a drag from one cell to another (clicks 1),
 * or a double or triple click at `to` (clicks 2 or 3).
 */
export interface Gesture {
  from: Cell;
  to: Cell;
  clicks: number;
  /** Cmd+A's drag, over the whole input. */
  whole: boolean;
}

/** The left button's presses and releases that make a gesture, in order, each its own report. */
export function gestureReports(g: Gesture): { at: Cell; action: "down" | "move" | "up" }[] {
  if (g.clicks < 2) return [{ at: g.from, action: "down" }, { at: g.to, action: "move" }, { at: g.to, action: "up" }];
  const pair: { at: Cell; action: "down" | "up" }[] = [{ at: g.to, action: "down" }, { at: g.to, action: "up" }];
  return Array.from({ length: Math.min(3, g.clicks) }, () => pair).flat();
}

/**
 * Claude's rule for a repeat click (Claude Code 2.1.317's bundle, `L2n` and
 * `Ts`): a press within this long of the last one, and within this many cells
 * of it in both directions, adds to the click count; any other starts it again.
 */
export const CLAUDE_MULTI_CLICK_MS = 500;
export const CLAUDE_MULTI_CLICK_CELLS = 1;
/**
 * Claude times a press when it reads the report, which can trail the plugin's
 * mousedown while it's busy drawing a turn: the wait covers that much more.
 */
const CLICK_MARGIN_MS = 150;

/**
 * How Cut remakes a selection its copy cleared without claude reading the
 * replay as more of the user's clicks: what to replay and how long to wait
 * first. A triple click needs no wait, since claude selects the line for any
 * count of three or more. A double click is replayed two or three cells along
 * from the last press, inside the same word (only letters, digits and _ from
 * the click to there, which every word boundary keeps together), so claude
 * counts it from one; with no room for that it waits. Claude's own word class
 * (2.1.317's bundle, `P1`) is letters, digits, and `_/.-+~\\`, so a run of
 * letters, digits and _ is always inside one of its words; a wide
 * character's second cell has no text, so it's never counted as one. A drag waits only when
 * its press would land near the last one. `lastPress`: where and when
 * (performance.now()) the user last pressed; `wordChar(col)`: whether that
 * column of the gesture's row is a letter, a digit or _.
 */
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

/**
 * What a key queue sends: text, or a step run in its turn (a mouse report,
 * say), each a gap from the next; or a wait, a pause of its own before the
 * next item.
 */
export type QueueItem = string | (() => void) | { wait: number };

/**
 * Sends keys one at a time, a gap apart, so a program reads each as a key and
 * never as a paste; while it's busy, every other input waits its turn at the
 * end (push), so a key typed right after a selection is replaced lands after
 * the keys that delete it, never between them. Busy until the gap after the
 * last key has passed. The timer is the caller's, so Node can test it. A
 * send or a step may push or clear: a push waits its turn, and a clear stops
 * the queue there.
 */
export class KeyQueue {
  private items: QueueItem[] = [];
  private timer: unknown = null;
  private stepping = false;
  /** Counts clears, so a step can tell it was cleared while it ran. */
  private cleared = 0;

  constructor(
    private readonly send: (data: string) => void,
    private readonly schedule: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (timer: unknown) => void,
    private readonly gap: number,
  ) {}

  get busy(): boolean {
    return this.timer !== null || this.items.length > 0 || this.stepping;
  }

  /** Adds to the end, and starts sending when idle. */
  push(...items: QueueItem[]): void {
    this.items.push(...items);
    if (this.timer === null && !this.stepping) this.step();
  }

  /** Drops whatever is still to send. */
  clear(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.items = [];
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
      else wait = item.wait;
    } finally {
      this.stepping = false;
    }
    if (this.cleared !== cleared) return;
    this.timer = this.schedule(() => this.step(), wait);
  }
}
