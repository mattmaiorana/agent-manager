
export type ProgramState =
  | "running"
  | "unknown"
  | "working"
  | "idle"
  | "waiting"
  | "finished"
  | "error"
  | "paused"
  | "exited";

export interface Attention {
  title: string;
  body: string;
  quiet?: boolean;
  needs?: boolean;
}

export const MOD_TOAST_TITLE = "inline-images";

const IDLE_GLYPH = "✳";
export const HOOK_ID = "vault-terminal-state";
export const BRIDGE_ID = "vault-terminal-bridge";
const HOOK_STATES: Record<string, ProgramState> = { working: "working", waiting: "waiting", finished: "finished", error: "error" };
const WORKING_GLYPH = /^[◐◓◑◒\u2800-\u28ff]$/u;

export function splitTitle(raw: string): { glyph: string; text: string } {
  const m = raw.match(/^(\S)\s+(.*)$/su);
  if (m && !/[\p{L}\p{N}]/u.test(m[1])) return { glyph: m[1], text: m[2].trim() };
  return { glyph: "", text: raw.trim() };
}

function stateFrom(body: string): ProgramState | null {
  if (/waiting for your input/i.test(body)) return "finished";
  if (/needs your permission/i.test(body)) return "waiting";
  return null;
}

export function waitingText(tool: string): string {
  if (tool === "AskUserQuestion") return "Claude has a question for you";
  if (tool === "ExitPlanMode") return "Claude has a plan for you to review";
  return tool ? `Claude needs your permission to use ${tool}` : "Claude needs your permission";
}

export class StatusTracker {
  state: ProgramState;
  title = "";
  private reportsStatus = false;
  private parts = new Map<string, Attention>();
  private progress: { state: ProgramState; percent: number | null; order: number } | null = null;
  private reported: { state: ProgramState | null; order: number } | null = null;
  statusText = "";
  private order = 0;

  constructor(
    private readonly firstState: "running" | "unknown",
    private readonly reporter: boolean,
    private readonly changed: () => void,
    private readonly attention: (a: Attention) => void,
    private readonly bridge?: (id: string, atStart: boolean) => void,
  ) {
    this.state = firstState;
  }

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
    this.background = false;
  }

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

  sessionStatus(data: string): void {
    let changed = false;
    for (const pair of data.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0 || pair.slice(0, eq) !== "status") continue;
      const value = pair.slice(eq + 1).trim();
      const states: Record<string, ProgramState> = { working: "working", waiting: "waiting", idle: "idle" };
      const state = Object.hasOwn(states, value.toLowerCase()) ? states[value.toLowerCase()] : null;
      if (!value) this.reported = null;
      else if (state) this.reported = { state, order: ++this.order };
      this.statusText = value && !state ? value : "";
      changed = true;
    }
    if (changed) this.changed();
  }

  get shown(): ProgramState {
    if (this.state === "exited") return "exited";
    return this.winner()?.state ?? this.state;
  }

  private winner(): { state: ProgramState; order: number } | null {
    if ((this.reportsStatus || this.reporter) && this.state !== "unknown") return null;
    const reports = [this.progress, this.reported?.state ? this.reported : null].filter((r): r is { state: ProgramState; order: number } => !!r);
    reports.sort((a, b) => b.order - a.order);
    return reports[0] ?? null;
  }

  get percent(): number | null {
    return this.state !== "exited" && this.progress && this.winner() === this.progress ? this.progress.percent : null;
  }

  private rawTitle = "";

  adopt(from: StatusTracker): void {
    if (!from.reportsStatus) return;
    this.statusQuery();
    if (from.rawTitle) this.setTitle(from.rawTitle);
    if (from.state === "waiting") this.set("waiting");
  }

  statusQuery(): void {
    this.reportsStatus = true;
    if (this.state === "running") this.set("unknown");
  }

  setTitle(raw: string): void {
    this.rawTitle = raw;
    const { glyph, text } = splitTitle(raw);
    const titleChanged = text !== this.title;
    this.title = text;
    let state = this.state;
    if (this.reportsStatus && this.state !== "exited") {
      if (WORKING_GLYPH.test(glyph)) state = "working";
      else if (glyph === IDLE_GLYPH && (this.state === "working" || this.state === "unknown")) state = "idle";
    }
    if (state !== this.state) this.set(state);
    else if (titleChanged) this.changed();
  }

  answered(): void {
    this.turnEndAnnounced = false;
    if (this.state === "waiting" || this.state === "finished" || (this.state === "error" && this.reporter)) this.set(this.reportsStatus ? "idle" : "unknown");
  }

  escaped(): void {
    if (this.state === "waiting" && (this.reporter || this.reportsStatus)) this.set("idle");
  }

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
    if (id === BRIDGE_ID) {
      const m = /^(turn|start)=([A-Za-z0-9_-]*)$/.exec(payload);
      if (m && (this.reporter || this.reportsStatus) && this.state !== "exited") this.bridge?.(m[2], m[1] === "start");
      return;
    }
    if (id === HOOK_ID) {
      const eq = payload.indexOf("=");
      const name = eq < 0 ? payload : payload.slice(0, eq);
      const tool = eq < 0 ? "" : payload.slice(eq + 1);
      const state = Object.hasOwn(HOOK_STATES, name) ? HOOK_STATES[name] : null;
      if (state && (this.reporter || this.reportsStatus) && this.state !== "exited") {
        const was = this.state;
        this.set(state);
        if (name === "finished") this.background = tool === "background";
        else if (name === "working" && tool === "background") this.background = true;
        if ((state === "finished" || state === "error") && was !== state && !this.turnEndAnnounced) {
          this.turnEndAnnounced = true;
          this.attention(state === "finished" ? { title: "", body: "Claude finished" } : { title: "", body: "Claude stopped with an error", needs: true });
        }
        if (state === "waiting" && !this.waitAnnounced) {
          this.waitAnnounced = true;
          this.attention({ title: "", body: waitingText(tool), needs: true });
        }
      }
      return;
    }
    const part = this.parts.get(id) ?? { title: "", body: "" };
    if (meta.get("e") !== "1") {
      if ((meta.get("p") ?? "title") === "body") part.body += payload;
      else if ((meta.get("p") ?? "title") === "title") part.title += payload;
    }
    this.parts.set(id, part);
    if ((meta.get("d") ?? "1") === "1") {
      this.parts.delete(id);
      if (part.title === MOD_TOAST_TITLE) {
        if (part.body && this.state !== "exited") this.attention({ ...part, quiet: true });
      } else if (part.title || part.body) this.notify(part);
    }
  }

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
    const state = this.reportsStatus || this.reporter ? stateFrom(a.body || a.title) : null;
    if (state) this.set(state);
    if (state === "finished" && this.turnEndAnnounced) return;
    if (state === "waiting" && this.waitAnnounced) return;
    this.attention({ ...a, needs: state === "waiting" });
  }

  private turnEndAnnounced = false;

  get asksStatus(): boolean {
    return this.reportsStatus;
  }

  private background = false;

  get backgroundWork(): boolean {
    return this.background && this.state !== "exited";
  }

  private waitAnnounced = false;

  private set(state: ProgramState): void {
    if (state === "working" || state === "waiting") this.turnEndAnnounced = false;
    if (state !== "waiting") this.waitAnnounced = false;
    if (state === this.state) return;
    this.state = state;
    this.changed();
  }
}
