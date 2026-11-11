
import { spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { clearTimeout, setTimeout } from "timers";
import type { Duplex } from "stream";
import HELPER_SOURCE from "./helper.py";

const BOOTSTRAP = "import os;exec(compile(os.environ.pop('VAULT_TERMINAL_HELPER'),'vault-terminal-helper','exec'))";
const CONTROL_LINE_CAP = 65536;
const CLOSE_FALLBACK_MS = 3000;

export interface SessionOptions {
  id: string;
  python: string;
  program: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
  cols: number;
  width?: number;
  height?: number;
  testDelay?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: number | string | null;
  closed?: string;
  ran?: number;
}

interface HelperMessage {
  type?: string;
  pid: number;
  tty?: unknown;
  pgid?: unknown;
  name?: unknown;
  script?: unknown;
  code: number | null;
  signal: number | string | null;
  closed?: string;
  ran?: unknown;
  kind?: string;
  message: string;
  errno?: number;
  program?: string;
}

export interface StartError {
  kind: "python" | "spawn" | "helper";
  message: string;
  errno?: number;
  program?: string;
}

export interface Foreground {
  pgid: number;
  name: string;
  script: string;
}

export interface SessionHandlers {
  data(chunk: Uint8Array): void;
  ready?(info: { pid: number; tty: string }): void;
  foreground?(info: Foreground): void;
  exit(info: ExitInfo): void;
  error(info: StartError): void;
}

export function validSize(rows: number, cols: number): boolean {
  return Number.isInteger(rows) && Number.isInteger(cols) && rows >= 2 && cols >= 2 && rows <= 10000 && cols <= 10000;
}

function pixels(n: number | undefined): number {
  return Number.isFinite(n) && (n as number) > 0 ? Math.min(65535, Math.round(n as number)) : 0;
}

export class HelperSession {
  readonly child: ChildProcess;
  private control: Duplex;
  private controlBuffer = "";
  private size: { rows: number; cols: number; width: number; height: number };
  private finished = false;
  private gotExit = false;
  private outputEnded = false;
  private last: (() => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = "";

  get diagnostics(): string {
    return this.stderrTail;
  }
  programPid = 0;
  tty = "";
  readonly programName: string;

  constructor(opts: SessionOptions, private handlers: SessionHandlers) {
    if (!validSize(opts.rows, opts.cols)) throw new Error(`invalid first size ${opts.rows}x${opts.cols}`);
    const width = pixels(opts.width);
    const height = pixels(opts.height);
    this.size = { rows: opts.rows, cols: opts.cols, width, height };
    this.programName = (opts.program[0] ?? "").split("/").pop() ?? "";
    const args = ["-I", "-c", BOOTSTRAP, "vault-terminal", opts.id, "--rows", String(opts.rows), "--cols", String(opts.cols), "--xpixel", String(width), "--ypixel", String(height), ...(opts.testDelay ? ["--test-delay", String(opts.testDelay)] : []), "--cwd", opts.cwd, "--", ...opts.program];
    this.child = spawn(opts.python, args, {
      cwd: homedir(),
      env: { ...opts.env, VAULT_TERMINAL_HELPER: HELPER_SOURCE },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.control = this.child.stdio[3] as Duplex;

    this.child.stdout!.on("data", (chunk: Buffer) => this.handlers.data(chunk));
    this.child.stdout!.on("end", () => {
      this.outputEnded = true;
      this.deliverLast();
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (s: string) => {
      this.stderrTail = (this.stderrTail + s).slice(-4096);
      console.debug(`[vault-terminal ${opts.id}] ${s.trimEnd()}`);
    });
    this.control.setEncoding("utf8");
    this.control.on("data", (s: string) => this.onControl(s));
    for (const stream of [this.child.stdin!, this.control]) stream.on("error", () => {});
    this.child.on("error", (err: NodeJS.ErrnoException) => {
      this.finish();
      this.handlers.error({ kind: "python", message: err.message, errno: typeof err.errno === "number" ? err.errno : undefined, program: opts.python });
    });
    this.child.on("close", (code, signal) => {
      if (!this.gotExit && !this.finished) {
        const detail = this.stderrTail.trim().split("\n").pop() ?? "";
        this.handlers.error({ kind: "helper", message: `The terminal's helper stopped unexpectedly (${signal ?? `code ${code}`}). ${detail}`.trim() });
      }
      this.outputEnded = true;
      this.deliverLast();
      this.finish();
    });
  }

  get running(): boolean {
    return !this.finished;
  }

  write(data: string | Uint8Array): void {
    if (this.finished || !this.child.stdin!.writable) return;
    this.child.stdin!.write(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }

  resize(rows: number, cols: number, widthPx = 0, heightPx = 0): void {
    if (this.finished || !validSize(rows, cols)) return;
    const width = pixels(widthPx);
    const height = pixels(heightPx);
    const s = this.size;
    if (rows === s.rows && cols === s.cols && width === s.width && height === s.height) return;
    this.size = { rows, cols, width, height };
    this.sendControl({ type: "resize", rows, cols, width, height });
  }

  pause(): void {
    this.child.stdout!.pause();
  }

  resume(): void {
    this.child.stdout!.resume();
  }

  close(withFallback = true): void {
    if (this.finished) return;
    this.sendControl({ type: "close" });
    this.child.stdin!.end();
    this.child.stdout!.resume();
    if (withFallback && !this.closeTimer) {
      this.closeTimer = setTimeout(() => this.kill(), CLOSE_FALLBACK_MS);
    }
  }

  kill(): void {
    if (this.programPid > 1) {
      try {
        process.kill(-this.programPid, "SIGKILL");
      } catch {
        /* empty */
      }
    }
    this.child.kill("SIGKILL");
    this.finish();
  }

  dropTimers(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  private sendControl(msg: object): void {
    if (!this.control.writable) return;
    this.control.write(JSON.stringify(msg) + "\n");
  }

  private onControl(text: string): void {
    this.controlBuffer += text;
    let nl: number;
    while ((nl = this.controlBuffer.indexOf("\n")) >= 0) {
      const line = this.controlBuffer.slice(0, nl);
      this.controlBuffer = this.controlBuffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: HelperMessage;
      try {
        msg = JSON.parse(line) as HelperMessage;
      } catch {
        console.warn("[vault-terminal] malformed control message from helper", line);
        continue;
      }
      if (msg.type === "ready") {
        this.programPid = msg.pid;
        this.tty = typeof msg.tty === "string" ? msg.tty : "";
        this.handlers.ready?.({ pid: msg.pid, tty: this.tty });
      } else if (msg.type === "foreground") {
        if (typeof msg.pgid === "number" && typeof msg.name === "string") this.handlers.foreground?.({ pgid: msg.pgid, name: msg.name, script: typeof msg.script === "string" ? msg.script : "" });
      } else if (msg.type === "exit") {
        this.gotExit = true;
        this.last = () => this.handlers.exit({ code: msg.code, signal: msg.signal, closed: msg.closed, ran: typeof msg.ran === "number" ? msg.ran : undefined });
        this.deliverLast();
      } else if (msg.type === "error") {
        this.gotExit = true;
        this.last = () => this.handlers.error({ kind: msg.kind === "spawn" ? "spawn" : "helper", message: msg.message, errno: msg.errno, program: msg.program });
        this.deliverLast();
      }
    }
    if (this.controlBuffer.length > CONTROL_LINE_CAP) this.controlBuffer = "";
  }

  private deliverLast(): void {
    if (!this.outputEnded || !this.last) return;
    const last = this.last;
    this.last = null;
    last();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.dropTimers();
  }
}
