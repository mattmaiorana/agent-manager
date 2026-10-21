// The plugin's side of one helper process: starts it, carries bytes both ways,
// sends control messages, and reports what the helper says. No Obsidian or
// xterm code here, so test/harness.ts can drive it from plain Node.

import { spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
// Node's timers, not the window's: this also runs in the Node test harness, which has no window.
import { clearTimeout, setTimeout } from "timers";
import type { Duplex } from "stream";
import HELPER_SOURCE from "./helper.py";

// Reads the helper's source from the environment, so `ps` shows a short line
// with the vault-terminal marker rather than the whole script.
const BOOTSTRAP = "import os;exec(compile(os.environ.pop('VAULT_TERMINAL_HELPER'),'vault-terminal-helper','exec'))";
const CONTROL_LINE_CAP = 65536;
/** How long a closed terminal's helper gets to finish its own cleanup before Node kills it. */
const CLOSE_FALLBACK_MS = 3000;

export interface SessionOptions {
  /** Shown in `ps` after the marker; any short identifier. */
  id: string;
  python: string;
  /** Program and arguments; the first element is resolved against env.PATH if not absolute. */
  program: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  rows: number;
  cols: number;
  /** The text area in CSS pixels, for the window size's pixel fields; 0 if unknown. */
  width?: number;
  height?: number;
  /** The self-test's slow start: the helper waits this many seconds before starting the program. */
  testDelay?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: number | string | null;
  /** Why the helper shut down, when the plugin or a lost parent ended it. */
  closed?: string;
  /** How long the program ran, in seconds, as the helper measured it: start to exit, without cleanup. */
  ran?: number;
}

/** A line of the helper's control channel, as the helper writes it (helper.py). */
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

/** The terminal's foreground program, as the helper last saw it. */
export interface Foreground {
  pgid: number;
  /** Its process name, as the system has it. */
  name: string;
  /** For an interpreter (node, python...), the script it runs; "" otherwise. */
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

/** A pixel size for the window size's 16-bit fields, rounded to whole pixels. */
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
  /** The helper's last word, held until its output has all arrived. */
  private last: (() => void) | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = "";

  /** The helper's last diagnostics, for the self-test. */
  get diagnostics(): string {
    return this.stderrTail;
  }
  programPid = 0;
  /** The program's terminal, as the helper reported it (/dev/ttys012). */
  tty = "";
  /** The started program's file name (zsh), to tell it from what it may exec into. */
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
    // Output and control messages come on separate pipes, so the exit message
    // can arrive while output is still on its way (or paused): it waits.
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
    // Writes to a helper that has gone fail with EPIPE; its exit is reported separately.
    for (const stream of [this.child.stdin!, this.control]) stream.on("error", () => {});
    this.child.on("error", (err: NodeJS.ErrnoException) => {
      this.finish();
      this.handlers.error({ kind: "python", message: err.message, errno: typeof err.errno === "number" ? err.errno : undefined, program: opts.python });
    });
    // "close", not "exit": it comes after every stdio stream has ended, so the
    // last output and the helper's exit message have already arrived.
    this.child.on("close", (code, signal) => {
      // The helper always sends exit or error before leaving; this covers it
      // being killed or crashing first.
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

  /** Bytes or text typed into the terminal, passed to the program unaltered. */
  write(data: string | Uint8Array): void {
    if (this.finished || !this.child.stdin!.writable) return;
    this.child.stdin!.write(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }

  /** Sends the size if it changed, the pixel size included. Callers coalesce to one call per frame. */
  resize(rows: number, cols: number, widthPx = 0, heightPx = 0): void {
    if (this.finished || !validSize(rows, cols)) return;
    const width = pixels(widthPx);
    const height = pixels(heightPx);
    const s = this.size;
    if (rows === s.rows && cols === s.cols && width === s.width && height === s.height) return;
    this.size = { rows, cols, width, height };
    this.sendControl({ type: "resize", rows, cols, width, height });
  }

  /** Stop taking output (backpressure); the helper then stops reading the pty. */
  pause(): void {
    this.child.stdout!.pause();
  }

  resume(): void {
    this.child.stdout!.resume();
  }

  /**
   * Ask the helper to end everything the program started, and stop sending
   * input. The helper does the work on its own; Node only kills it if it is
   * still alive after a few seconds. Safe to call more than once.
   */
  close(withFallback = true): void {
    if (this.finished) return;
    this.sendControl({ type: "close" });
    this.child.stdin!.end();
    // Output paused for backpressure would never reach its end, so the
    // process's "close" (and everything waiting on it) would never come: the
    // rest is read and goes to the handler as before.
    this.child.stdout!.resume();
    if (withFallback && !this.closeTimer) {
      this.closeTimer = setTimeout(() => this.kill(), CLOSE_FALLBACK_MS);
    }
  }

  /** Last resort: the helper didn't finish, so kill the program's group and the helper. */
  kill(): void {
    if (this.programPid > 1) {
      try {
        process.kill(-this.programPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    this.child.kill("SIGKILL");
    this.finish();
  }

  /** Forget the fallback timer, for plugin unload. The helper still cleans up. */
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
