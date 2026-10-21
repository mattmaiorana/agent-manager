// What a terminal's program is doing, from what it tells the terminal and
// nothing else. No Obsidian or xterm code here, so test/harness.ts can drive it.
//
// claude's signals, as logged in a test vault:
// - It asks about the Program Status Protocol (OSC 7501 ; ?) at start. No
//   public spec says how to answer, so it isn't answered, and the query only
//   marks the program as one whose title carries its state.
// - Its title (OSC 0) starts with a spinner glyph while it works, and with
//   "✳" when it isn't working, whether it's done or waiting for permission.
// - With the kitty notification channel, it sends a notification (OSC 99)
//   when it needs you and you seem away: "Claude needs your permission"
//   about 6 s into a permission prompt, "Claude is waiting for your input"
//   about 60 s after finishing.
// - With the hooks the terminal passes per session (claude.ts; 70), an OSC 99
//   with the terminal's own id at once: working when a prompt is sent or a
//   tool returns, waiting at a permission prompt, finished when the reply
//   ends, error when the turn fails. The title still covers what no hook
//   reports: an interrupt (✳ after working) and a turn claude starts itself.

export type ProgramState =
  /** A program that reports nothing beyond running. */
  | "running"
  /** claude, before it has said anything readable. */
  | "unknown"
  | "working"
  /** Not working; claude hasn't said why (done, or waiting). */
  | "idle"
  | "waiting"
  | "finished"
  /** A progress report said it failed (OSC 9;4 error). */
  | "error"
  /** A progress report said it's paused (OSC 9;4 paused): not waiting for you. */
  | "paused"
  | "exited";

export interface Attention {
  title: string;
  body: string;
}

const IDLE_GLYPH = "✳";
/** The OSC 99 id of the hooks' state reports (claude.ts). */
export const HOOK_ID = "vault-terminal-state";
const HOOK_STATES: Record<string, ProgramState> = { working: "working", waiting: "waiting", finished: "finished", error: "error" };
// Spinner glyphs claude was seen using while it works: quarter circles now,
// braille in older versions (its changelog). Any other glyph means nothing.
const WORKING_GLYPH = /^[◐◓◑◒\u2800-\u28ff]$/u;

/** A title's leading status glyph, if it has one, and the rest. */
export function splitTitle(raw: string): { glyph: string; text: string } {
  const m = raw.match(/^(\S)\s+(.*)$/su);
  if (m && !/[\p{L}\p{N}]/u.test(m[1])) return { glyph: m[1], text: m[2].trim() };
  return { glyph: "", text: raw.trim() };
}

/**
 * What a notification's text says about the program: only the two texts
 * claude was seen sending. Anything else says nothing about its state.
 */
function stateFrom(body: string): ProgramState | null {
  if (/waiting for your input/i.test(body)) return "finished";
  if (/needs your permission/i.test(body)) return "waiting";
  return null;
}

export class StatusTracker {
  state: ProgramState;
  /** The program's own title, without its status glyph; empty until it sets one. */
  title = "";
  /** The program asked about the Program Status Protocol: claude 2.1.295 or later. */
  private reportsStatus = false;
  private parts = new Map<string, Attention>();
  /** The last progress report (OSC 9;4), and when, in order with the session status. */
  private progress: { state: ProgramState; percent: number | null; order: number } | null = null;
  /** The last session status (OSC 21337): a state, and text shown on the tab. */
  private reported: { state: ProgramState | null; order: number } | null = null;
  /** OSC 21337's status text when it isn't one of the states. */
  statusText = "";
  private order = 0;

  constructor(
    private readonly firstState: "running" | "unknown",
    /** The terminal's own program is an agent known to report its state (claude). */
    private readonly reporter: boolean,
    private readonly changed: () => void,
    private readonly attention: (a: Attention) => void,
  ) {
    this.state = firstState;
  }

  /** A new program started in the terminal. */
  start(): void {
    this.reportsStatus = false;
    this.parts.clear();
    this.title = "";
    this.clearReports();
    this.set(this.firstState);
  }

  exit(): void {
    this.set("exited");
  }

  /**
   * A program run from the shell ended and the shell is back: what that
   * program said about itself is over, its claude-ness included.
   */
  programReturned(): void {
    if (this.firstState !== "running" || this.state === "exited") return;
    this.reportsStatus = false;
    this.rawTitle = "";
    this.parts.clear();
    this.clearReports();
    this.set("running");
  }

  private clearReports(): void {
    this.progress = null;
    this.reported = null;
    this.statusText = "";
  }

  /**
   * OSC 9 ; 4 ; state ; percent: 0 clear, 1 percent,
   * 2 error, 3 indeterminate, 4 paused. Clearing returns the tab to what its
   * other signals say, not to finished.
   */
  progressReport(data: string): void {
    const [, st, pr] = data.split(";");
    const percent = pr !== undefined && /^\d+$/.test(pr) ? Math.min(100, Number(pr)) : null;
    switch (st) {
      case "0":
        this.progress = null;
        break;
      case "1":
        this.progress = { state: "working", percent, order: ++this.order };
        break;
      case "2":
        this.progress = { state: "error", percent, order: ++this.order };
        break;
      case "3":
        this.progress = { state: "working", percent: null, order: ++this.order };
        break;
      case "4":
        this.progress = { state: "paused", percent, order: ++this.order };
        break;
      default:
        return;
    }
    this.changed();
  }

  /**
   * iTerm2's session status, OSC 21337 ; key=value ; ... (71). status of
   * Working, Waiting or Idle sets that state; other text shows on the tab
   * without changing it; an empty value clears the field; other keys
   * (indicator, status-color, detail, anything unknown) are ignored.
   */
  sessionStatus(data: string): void {
    let changed = false;
    for (const pair of data.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0 || pair.slice(0, eq) !== "status") continue;
      const value = pair.slice(eq + 1).trim();
      // Own keys only: "constructor" or "toString" isn't a state.
      const states: Record<string, ProgramState> = { working: "working", waiting: "waiting", idle: "idle" };
      const state = Object.hasOwn(states, value.toLowerCase()) ? states[value.toLowerCase()] : null;
      // Other text shows beside the name and leaves the state as it was.
      if (!value) this.reported = null;
      else if (state) this.reported = { state, order: ++this.order };
      this.statusText = value && !state ? value : "";
      changed = true;
    }
    if (changed) this.changed();
  }

  /**
   * What the tab shows. claude's own signals come first; otherwise the most
   * recent of a progress report and a session status; otherwise the state.
   */
  get shown(): ProgramState {
    if (this.state === "exited") return "exited";
    return this.winner()?.state ?? this.state;
  }

  /** The report the tab shows, if one wins over the state: null when claude's own signals or the state itself do. */
  private winner(): { state: ProgramState; order: number } | null {
    if ((this.reportsStatus || this.reporter) && this.state !== "unknown") return null;
    const reports = [this.progress, this.reported?.state ? this.reported : null].filter((r): r is { state: ProgramState; order: number } => !!r);
    reports.sort((a, b) => b.order - a.order);
    return reports[0] ?? null;
  }

  /**
   * The percent a progress report gave, while that report is the one shown:
   * not when a later session status or claude's own signals win, even with
   * the same state.
   */
  get percent(): number | null {
    return this.state !== "exited" && this.progress && this.winner() === this.progress ? this.progress.percent : null;
  }

  /** The title as the program last sent it, glyph and all. */
  private rawTitle = "";

  /**
   * An agent recognized in a shell tab after it started: what it
   * already said, to the shell's tracker, is its own. Its status query
   * first, then its title, whose glyph only counts after the query.
   */
  adopt(from: StatusTracker): void {
    // Only an agent that asked the status query says anything about itself
    // early (claude); otherwise the shell's last title is the shell's own
    // (a prompt that titles the window), not the agent's.
    if (!from.reportsStatus) return;
    this.statusQuery();
    if (from.rawTitle) this.setTitle(from.rawTitle);
    // A permission prompt it already showed: still waiting, whatever the title's glyph says.
    if (from.state === "waiting") this.set("waiting");
  }

  /** OSC 7501 ; ? */
  statusQuery(): void {
    this.reportsStatus = true;
    if (this.state === "running") this.set("unknown");
  }

  /** OSC 0 or 2. */
  setTitle(raw: string): void {
    this.rawTitle = raw;
    const { glyph, text } = splitTitle(raw);
    const titleChanged = text !== this.title;
    this.title = text;
    let state = this.state;
    if (this.reportsStatus && this.state !== "exited") {
      if (WORKING_GLYPH.test(glyph)) state = "working";
      // Not working: but whether it's done or waiting, only a notification says.
      else if (glyph === IDLE_GLYPH && (this.state === "working" || this.state === "unknown")) state = "idle";
    }
    if (state !== this.state) this.set(state);
    else if (titleChanged) this.changed();
  }

  /**
   * The user answered the program (pressed Return). Whatever it last said about
   * waiting or being finished is no longer known to be true; a program
   * without titles would otherwise show it until its next notification.
   */
  answered(): void {
    this.turnEndAnnounced = false;
    if (this.state === "waiting" || this.state === "finished" || (this.state === "error" && this.reporter)) this.set(this.reportsStatus ? "idle" : "unknown");
  }

  /**
   * The user pressed Escape. At a permission prompt that's a denial, which no
   * hook reports: claude is then idle, waiting for the user.
   */
  escaped(): void {
    if (this.state === "waiting" && (this.reporter || this.reportsStatus)) this.set("idle");
  }

  /**
   * OSC 99, kitty's desktop notification: `metadata;payload`, metadata as
   * colon-separated key=value. A notification can come in parts with the
   * same id; d=0 means more follow, and d=1 (the default) ends it.
   */
  kittyNotification(data: string): void {
    const semi = data.indexOf(";");
    if (semi < 0) return;
    const meta = new Map<string, string>();
    for (const kv of data.slice(0, semi).split(":")) {
      const eq = kv.indexOf("=");
      if (eq > 0) meta.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    const payload = data.slice(semi + 1);
    const id = meta.get("i") ?? "";
    // A hook's state report: a state, never a notification.
    if (id === HOOK_ID) {
      // Own keys only: "constructor" or "__proto__" from a program is no state.
      const state = Object.hasOwn(HOOK_STATES, payload) ? HOOK_STATES[payload] : null;
      if (state && (this.reporter || this.reportsStatus) && this.state !== "exited") {
        const was = this.state;
        this.set(state);
        // The turn ended: said at once, from the hook, rather than in
        // claude's own "waiting for your input" a minute later, which is
        // then left out for this turn.
        if ((state === "finished" || state === "error") && was !== state && !this.turnEndAnnounced) {
          this.turnEndAnnounced = true;
          this.attention({ title: "", body: state === "finished" ? "Claude finished" : "Claude stopped with an error" });
        }
      }
      return;
    }
    const part = this.parts.get(id) ?? { title: "", body: "" };
    // Base64 payloads (e=1) aren't decoded; claude sends plain text.
    if (meta.get("e") !== "1") {
      if ((meta.get("p") ?? "title") === "body") part.body += payload;
      else if ((meta.get("p") ?? "title") === "title") part.title += payload;
    }
    this.parts.set(id, part);
    if ((meta.get("d") ?? "1") === "1") {
      this.parts.delete(id);
      if (part.title || part.body) this.notify(part);
    }
  }

  /** OSC 9 (iTerm2's notification; 9;4 is progress, not a notification) and OSC 777;notify. */
  otherNotification(code: 9 | 777, data: string): void {
    if (code === 9) {
      if (data.startsWith("4;")) return this.progressReport(data);
      if (/^\d+;/.test(data)) return;
      this.notify({ title: "", body: data });
    } else {
      const [kind, title = "", ...body] = data.split(";");
      if (kind === "notify") this.notify({ title, body: body.join(";") });
    }
  }

  private notify(a: Attention): void {
    if (this.state === "exited") return;
    // Only a program that reports its state says what its notifications
    // mean: an installer's "waiting for your input" isn't claude's.
    const state = this.reportsStatus || this.reporter ? stateFrom(a.body || a.title) : null;
    if (state) this.set(state);
    // claude's reminder that it's waiting, for a turn whose end was already announced.
    if (state === "finished" && this.turnEndAnnounced) return;
    this.attention(a);
  }

  /** The current turn's end (finished, or an error) was announced: claude's own reminder of it is left out. Reset when a new turn starts. */
  private turnEndAnnounced = false;

  /** The program asked about the Program Status Protocol, which only claude 2.1.295 or later is known to do. */
  get asksStatus(): boolean {
    return this.reportsStatus;
  }

  private set(state: ProgramState): void {
    if (state === "working" || state === "waiting") this.turnEndAnnounced = false;
    if (state === this.state) return;
    this.state = state;
    this.changed();
  }
}
