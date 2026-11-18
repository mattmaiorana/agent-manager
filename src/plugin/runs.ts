
import { import_child_process, import_obsidian, fs, os, path } from "../externals.js";
import { OUTPUTS_FOLDER, RUN_LOG_FILE, TASK_MEMORY_FILE } from "../constants/scheduled.js";
import { plainSessionName } from "../constants/names.js";
import { continueSession, scheduledEnv } from "../scheduled/run-args.js";
import { parseRunLog, renderRunLog, runLogUpsert, runParseStarted, runStamp, runTook } from "../scheduled/run-core.js";
import type { RunRow } from "../scheduled/run-core.js";
import { neverReads } from "../scheduled/task-model.js";
import type { ResolvedReach, ScheduledTask } from "../scheduled/task-model.js";
import { lastMessageTsOf } from "../sessions/transcript-files.js";
import type { TaskView } from "./scheduler.js";
import type { AgentManagerPlugin } from "./main.js";
import type { Session } from "../sessions/controller.js";
import type { SessionRunState } from "../scheduled/session-run.js";
import { notice } from "../vault-terminal/notice";

export interface LiveRun {
  claim: boolean;
  task: { name: string; label: string; folder: string; notePath: string; output: string; projectFolder: string | null; followUp: "" | "ticket"; tab?: "keep" | "close" };
  killedFor: "stopped" | "interrupted" | null;
  refusal: string;
  start: number;
  started: string;
  stamp: string;
  occurrence: string;
  sessionId: string;
  title: string;
  quiet: boolean;
  onlyWhenNew: boolean;
  awake?: { kill: () => boolean } | null;
  session?: Session | null;
  states?: SessionRunState[];
  waitingSaid?: boolean;
  stalledSaid?: boolean;
  stopped?: boolean;
  timeLimitMin?: number;
  priorRows?: RunRow[];
  openedAt?: number;
  web?: { mode: "off" | "search" | "sites"; sites: string[] };
  runRel: string;
  resultRel: string;
  memoryRel: string;
  memoryAtStart: string | null;
  agentId: string;
  agentName: string | null;
  key: string;
  spawnError: string;
  searched: string[];
  read: string[];
  done: boolean;
}

const SESSIONS_KEY = "agent-manager-task-sessions";

class RunMethods {
  machineName(this: AgentManagerPlugin): string {
    try { return os.hostname().replace(/\.local$/i, "") || "this computer"; } catch { return "this computer"; }
  }
  liveRuns(this: AgentManagerPlugin): Map<string, LiveRun> {
    if (!this._liveRuns) this._liveRuns = new Map();
    return this._liveRuns;
  }
  activeRunCount(this: AgentManagerPlugin): number {
    let n = 0;
    for (const r of this.liveRuns().values()) if (!(r.waitingSaid || r.stalledSaid)) n++;
    return n;
  }
  runFor(this: AgentManagerPlugin, t: ScheduledTask | null | undefined): LiveRun | null {
    return t ? this.liveRuns().get(t.folder) || null : null;
  }
  _taskSessions(this: AgentManagerPlugin): Record<string, { session: string; key: string; mtime: number; lastMsg?: number }> {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(SESSIONS_KEY); } catch { /* empty */ }
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, { session: string; key: string; mtime: number; lastMsg?: number }> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as { session?: unknown; key?: unknown; mtime?: unknown; lastMsg?: unknown } | null;
      if (r && typeof r.session === "string" && typeof r.key === "string") out[k] = { session: r.session, key: r.key, mtime: typeof r.mtime === "number" ? r.mtime : -1, ...(typeof r.lastMsg === "number" ? { lastMsg: r.lastMsg } : {}) };
    }
    return out;
  }
  _saveTaskSession(this: AgentManagerPlugin, notePath: string, session: string, key: string, mtime = -1, lastMsg?: number): void {
    const all = this._taskSessions();
    all[notePath] = { session, key, mtime, ...(lastMsg != null ? { lastMsg } : {}) };
    try { this.app.saveLocalStorage(SESSIONS_KEY, all); } catch { /* empty */ }
  }
  runLogPath(this: AgentManagerPlugin, folder: string): string {
    return (0, import_obsidian.normalizePath)(`${folder}/${RUN_LOG_FILE}`);
  }
  async readRunLogStrict(this: AgentManagerPlugin, folder: string): Promise<RunRow[]> {
    const p = this.runLogPath(folder);
    if (!(await this.app.vault.adapter.exists(p))) return [];
    return parseRunLog(await this.app.vault.adapter.read(p));
  }
  async writeRunRow(this: AgentManagerPlugin, folder: string, row: RunRow): Promise<boolean> {
    const p = this.runLogPath(folder);
    if (!this._runLogChains) this._runLogChains = new Map();
    const prev = this._runLogChains.get(p) || Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const rows = await this.readRunLogStrict(folder);
      await this.app.vault.adapter.write(p, renderRunLog(runLogUpsert(rows, row)));
    });
    this._runLogChains.set(p, next.catch(() => undefined));
    return next.then(() => true, (e: unknown) => { console.error("[Agent Manager] run log write failed:", e); return false; });
  }
  async writeFinalRunRow(this: AgentManagerPlugin, folder: string, row: RunRow, label: string, notePath: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (await this.writeRunRow(folder, row)) return;
      if (this._unloading) return;
      await new Promise((r) => window.setTimeout(r, 2000 * (i + 1)));
    }
    if (this._unloading) return;
    this.notifyDesktop({ head: "Run log not updated", name: label, detail: `The run ended (${row.Outcome}), but its run log couldn't be written, so it may still say "running".` }, notePath);
  }
  async runNow(this: AgentManagerPlugin, v: TaskView): Promise<boolean> {
    if (v.task.problems.length) { notice({ head: `“${v.task.label}” can't run yet`, detail: v.task.problems[0] }); return false; }
    if (!v.approved && !(await this.approveTask(v))) return false;
    const now = await this.taskViewByPath(v.task.notePath);
    if (!now || !now.approved) { notice({ head: `“${v.task.label}” changed while it was being approved`, detail: "Approve it again." }); return false; }
    return this.runScheduledTask(now, { occurrence: "Run now", quiet: false });
  }
  async runScheduledTask(this: AgentManagerPlugin, v: TaskView, { occurrence, quiet }: { occurrence: string; quiet: boolean }): Promise<boolean> {
    const t = v.task;
    const say = (m: string): false => {
      if (quiet) (this._startRefused || (this._startRefused = new Map())).set(`${t.folder}|${occurrence}`, m);
      if (quiet) console.warn(`[Agent Manager] ${t.label}: ${m}`);
      else notice({ head: "Scheduled run didn't start", detail: m.charAt(0).toUpperCase() + m.slice(1) });
      return false;
    };
    if (this._unloading) return false;
    if (!this.scheduledTasksOn()) return say("scheduled tasks are off (Settings → Agent Manager → Scheduled tasks).");
    if (t.problems.length) return say(`“${t.label}” can't run until it's fixed: ${t.problems[0]}`);
    if (!v.approved) return say(`“${t.label}” isn't approved on this computer for what it can reach now.`);
    if (this.runFor(t)) return say(`“${t.label}” is already running.`);
    const settings = this.schedSettings();
    if (this.activeRunCount() >= settings.runsAtOnce) return say(`${this.activeRunCount()} runs are going, the most at once (a setting). Try again when one finishes.`);
    const claim = { claim: true, task: { name: t.name, label: t.label, folder: t.folder, notePath: t.notePath, output: t.output, projectFolder: t.projectFolder, followUp: t.followUp, tab: t.tab }, killedFor: null, refusal: "" } as LiveRun;
    this.liveRuns().set(t.folder, claim);
    this._keepAwake(claim);
    this._taskCache = null;
    this.refreshBrowsers();
    let started = false;
    try {
      started = await this._startRun(v, claim, settings, say, { occurrence, quiet });
      return started;
    } catch (e) {
      console.error("[Agent Manager] run failed to start:", e);
      return say(`“${t.label}” couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (!started && this.liveRuns().get(t.folder) === claim) this.liveRuns().delete(t.folder);
      if (!started) this._letSleep(claim);
      this.refreshBrowsers();
    }
  }
  async _startRun(this: AgentManagerPlugin, v: TaskView, run: LiveRun, settings: { timeLimitMin: number; runsAtOnce: number; commitRuns: boolean }, say: (m: string) => false, { occurrence, quiet }: { occurrence: string; quiet: boolean }): Promise<boolean> {
    const t = v.task;
    this._taskCache = null;
    const now = await this.taskViewByPath(t.notePath);
    if (!now || now.key !== v.key || !now.approved) return say(`“${t.label}” changed before it started. It runs once it's approved as it is now.`);
    if (quiet && (now.task.paused || !this.schedulerOn())) return say(`“${t.label}” was paused, or the schedule turned off, before it started.`);
    if (now.task.problems.length) return say(`“${t.label}” can't run: ${now.task.problems[0]}`);
    const reach: ResolvedReach = v.reach;
    const key = v.key;
    const vault = path.resolve(this.getVaultPath());
    const abs = (rel: string) => (rel ? path.join(vault, rel) : vault);
    const launch = await this.terminal?.agentProgram("claude", abs(t.folder));
    if (!launch) return say("the terminal isn't loaded yet.");
    if ("error" in launch) return say(`Claude Code can't be found: ${launch.error}`);
    const start = new Date();
    const outputsRel = `${t.folder}/${OUTPUTS_FOLDER}`;
    const taken = (s: string) => fs.existsSync(abs(`${outputsRel}/${s}`)) || fs.existsSync(abs(`${outputsRel}/${s}.md`));
    let stamp = runStamp(start);
    if (taken(stamp)) stamp = runStamp(start, true);
    for (let n = 2; taken(stamp); n++) stamp = `${runStamp(start, true)} ${n}`;
    const runLocal = `${OUTPUTS_FOLDER}/${stamp}`;
    const runRel = `${t.folder}/${runLocal}`;
    const resultLocal = `${runLocal}/Result.md`;
    const memoryLocal = `${runLocal}/${TASK_MEMORY_FILE}`;
    const memoryRel = `${t.folder}/${TASK_MEMORY_FILE}`;
    let memoryAtStart: string | null = null;
    const memoryBlocked = neverReads(reach.neverRead, abs(memoryRel));
    if (!memoryBlocked) memoryAtStart = readOwnFile(abs(memoryRel), abs(t.folder));
    const agentId = this.taskAgentId(t);
    const agent = this.agentById(agentId);
    const lastSession = this._taskSessions()[t.notePath] || null;
    let resumeId = continueSession(t.eachRun, lastSession, key);
    const openTab = resumeId ? this.sessionObjects().find((s) => s._ownSessionId() === resumeId) : null;
    if (openTab && [", ", " ("].some((sep) => openTab.sessionTitle?.startsWith(`${plainSessionName(t.name) || "Scheduled task"}${sep}`)) && !this.sessionIsWorking(openTab) && !openTab.hasPendingInput() && openTab.programState !== "waiting") {
      openTab._closeQuietly = true;
      openTab.leaf.detach();
    } else if (openTab) return say(`“${t.label}” continues its last session, which is open in a tab and busy, or typed into. Close the tab, then run it.`);
    if (resumeId) {
      const found = this.readStore("claude", new Set([reach.cwd, fs.realpathSync(reach.cwd)]), resumeId);
      const unchanged = !!found.length && !!found[0].file && lastSession?.lastMsg != null && lastMessageTsOf(found[0].file) === lastSession.lastMsg;
      if (!unchanged) resumeId = null;
    }
    let fresh: RunRow[];
    try { fresh = await this.readRunLogStrict(t.folder); } catch (e) { return say(`its run log can't be read, so it won't start: ${e instanceof Error ? e.message : String(e)}`); }
    if (occurrence !== "Run now") {
      const tries = fresh.filter((r) => r.Occurrence === occurrence);
      if (tries.length) return say(`${occurrence} has already been run.`);
    }
    return this.startSessionRun(v, run, {
      occurrence, quiet, start, stamp, runRel, resultRel: `${t.folder}/${resultLocal}`, memoryRel,
      memoryLocalRel: `${t.folder}/${memoryLocal}`, memoryAtStart, resumeId, rows: fresh, key,
      agentId, agentName: agent?.name || null, timeLimitMin: settings.timeLimitMin,
    }, say);
  }
  _runRow(this: AgentManagerPlugin, run: LiveRun, o: Partial<RunRow>): RunRow {
    return { Started: run.started, Occurrence: run.occurrence, Outcome: "running", Took: "", Result: "", Session: run.sessionId, Backend: "claude", Machine: this.machineName(), Note: "", ...o };
  }
  killRun(this: AgentManagerPlugin, run: LiveRun, why: NonNullable<LiveRun["killedFor"]>): void {
    if (run.done) return;
    if (!run.killedFor) run.killedFor = why;
  }
  stopRun(this: AgentManagerPlugin, t: ScheduledTask): void {
    const run = this.runFor(t);
    if (!run) return;
    if (!run.claim) { run.stopped = true; void run.session?._writeInput("\x1b").catch(() => undefined); void this.watchSessionRun(run); return; }
    this.killRun(run, "stopped");
  }
  killAllRuns(this: AgentManagerPlugin): void {
    for (const run of this.liveRuns().values()) {
      this._letSleep(run);
      if (!run.killedFor) run.killedFor = "interrupted";
    }
  }
  _keepAwake(this: AgentManagerPlugin, run: LiveRun): void {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/caffeinate")) return;
    try {
      const c = import_child_process.spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      c.on("error", () => undefined);
      run.awake = c;
    } catch { /* empty */ }
  }
  _letSleep(this: AgentManagerPlugin, run: LiveRun): void {
    try { run.awake?.kill(); } catch { /* empty */ }
    run.awake = null;
  }
  async commitPaths(this: AgentManagerPlugin, paths: string[], message: string): Promise<boolean> {
    const vault = path.resolve(this.getVaultPath());
    if (!paths.length || !fs.existsSync(path.join(vault, ".git"))) return false;
    const env = this.terminal ? await this.terminal.agentProgram("claude", vault) : null;
    const gitEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env && !("error" in env) ? scheduledEnv(env.env) : scheduledEnv(process.env))) if (!/^GIT_/.test(k)) gitEnv[k] = v;
    const git = (args: string[]) => new Promise<string>((resolve, reject) => {
      import_child_process.execFile("git", ["-c", "core.hooksPath=/dev/null", "-C", vault, ...args], { env: gitEnv, timeout: 60000, encoding: "utf8" }, (err, so, se) => (err ? reject(new Error(String(se || err.message).trim())) : resolve(String(so))));
    });
    const wait = (ms: number) => new Promise<void>((r) => { this.scheduleTimeout(r, ms); });
    const step = (this._gitChain || Promise.resolve(true)).then(async () => {
      for (let i = 0; i < 30 && fs.existsSync(path.join(vault, ".git", "index.lock")); i++) {
        if (this._unloading) return false;
        await wait(2000);
      }
      if (this._unloading) return false;
      await git(["add", "--", ...paths]);
      if (this._unloading) return false;
      await git(["commit", "--only", "-m", message, "--", ...paths]);
      return true;
    }).catch((e: unknown) => {
      console.error("[Agent Manager] run commit failed:", e);
      this.notify({ head: "A run's result wasn't committed", detail: e instanceof Error ? e.message : String(e) });
      return false;
    });
    this._gitChain = step;
    return step;
  }
  async cleanupLeftoverRuns(this: AgentManagerPlugin): Promise<void> {
    const me = this.machineName();
    for (const { task: t } of await this.scheduledTasks()) {
      if (this.runFor(t) || this._unloading) continue;
      let changed = false;
      let rows: RunRow[];
      try { rows = await this.readRunLogStrict(t.folder); } catch { continue; }
      for (const r of rows) {
        if ((r.Outcome === "running" || r.Outcome === "waiting" || r.Outcome === "stalled") && r.Machine === me) {
          changed = true;
          const at = runParseStarted(r.Started);
          await this.writeRunRow(t.folder, { ...r, Outcome: "interrupted", Took: r.Took || (at ? `${runTook(Date.now() - at.getTime())} or less` : ""), Note: "Obsidian closed or the plugin reloaded during the run." });
        }
      }
      if (changed && this.schedSettings().commitRuns) await this.commitPaths([this.runLogPath(t.folder)], `Scheduled: ${t.label}, interrupted run logged`);
    }
    this._taskCache = null;
  }
}
export { RunMethods };

export function readOwnFile(p: string, root: string): string | null {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.nlink > 1) return null;
    const real = fs.realpathSync(p);
    const top = fs.realpathSync(root);
    if (!real.startsWith(top + "/")) return null;
    return fs.readFileSync(real, "utf8");
  } catch { return null; }
}

export function writeOwnFile(p: string, root: string, text: string): void {
  const dir = fs.realpathSync(path.dirname(p));
  const top = fs.realpathSync(root);
  if (dir !== top && !dir.startsWith(top + "/")) throw new Error(`${p} isn't inside ${root}`);
  try { if (fs.lstatSync(p).nlink > 1) throw new Error(`${p} has another name (a hard link)`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
}

