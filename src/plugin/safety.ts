
import { import_child_process, import_obsidian, crypto, fs, os, path } from "../externals.js";
import { NEVER_READ_ANYWHERE, NEVER_READ_HOME } from "../constants/scheduled.js";
import { scheduledEnv } from "../scheduled/run-args.js";
import { neverReads } from "../scheduled/task-model.js";
import { runFailureKind, runStarted } from "../scheduled/run-core.js";
import { argvMatchesReal, CHECK_MODEL, collectStream, controlArgs, couldntRun, fixtureProblem, judgePhase, mergeRetry, modelUnavailable, parseVersion, PHASE_LABEL, phaseOutcome, phasesFor, plannedKey, retryDelayMs, retrySteps, SAFETY_NOTE, SAFETY_PHASES, safetyArgs, safetyFixture, safetyGate, safetyNoteText, safetyPrompt, safetySection } from "../scheduled/safety-core.js";
import type { Gate, PhaseResult, SafetyFixture, SafetyPhase, TaskNeeds } from "../scheduled/safety-core.js";
import type { TaskView } from "./scheduler.js";
import type { AgentManagerPlugin } from "./main.js";
import { notice } from "../vault-terminal/notice";

const AUTO_KEY = "agent-manager-safety-auto";
const LAST_PASS_KEY = "agent-manager-safety-last-pass";
const RESULTS_KEY = "agent-manager-safety-results";
const SCRATCH_KEY = "agent-manager-safety-scratch";
const VERSION_MS = 30000;
const RUN_MS = 4 * 60000;
const CONTROL_MS = 60000;

type ClaudeFound = { program: string; real: string; version: string; env: Record<string, string> };
type Spawned = { stream: string; stderr: string; exitCode: number | null; spawnError: string };

class SafetyMethods {
  safetyAutoOn(this: AgentManagerPlugin): boolean {
    try { return this.app.loadLocalStorage(AUTO_KEY) === true; } catch { return false; }
  }
  setSafetyAutoOn(this: AgentManagerPlugin, on: boolean): void {
    try { this.app.saveLocalStorage(AUTO_KEY, on); } catch { /* empty */ }
    this.refreshBrowsers();
    if (on) void this.schedulerTick();
  }
  safetyResults(this: AgentManagerPlugin): Partial<Record<SafetyPhase, PhaseResult & { tries?: number }>> {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(RESULTS_KEY); } catch { /* empty */ }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Partial<Record<SafetyPhase, PhaseResult & { tries?: number }>> = {};
    for (const p of SAFETY_PHASES) {
      const r = (raw as Record<string, unknown>)[p] as Partial<PhaseResult & { tries?: number }> | undefined;
      if (r && typeof r.key === "string" && typeof r.outcome === "string" && Array.isArray(r.cases)) out[p] = r as PhaseResult & { tries?: number };
    }
    return out;
  }
  _saveSafetyResult(this: AgentManagerPlugin, r: PhaseResult): PhaseResult & { tries: number } {
    const all = this.safetyResults();
    const prev = all[r.phase];
    const tries = (r.outcome === "couldn't run" || r.outcome === "inconclusive") ? (prev && prev.key === r.key && (prev.outcome === "couldn't run" || prev.outcome === "inconclusive") ? (prev.tries || 1) + 1 : 1) : 0;
    const saved = { ...r, tries };
    all[r.phase] = saved;
    try { this.app.saveLocalStorage(RESULTS_KEY, all); } catch { /* empty */ }
    if (r.phase === "locked" && r.outcome === "passed") { try { this.app.saveLocalStorage(LAST_PASS_KEY, { at: r.at, version: r.version }); } catch { /* empty */ } }
    return saved;
  }
  safetyLastPass(this: AgentManagerPlugin): { at: number; version: string } | null {
    let raw: unknown = null;
    try { raw = this.app.loadLocalStorage(LAST_PASS_KEY); } catch { /* empty */ }
    const r = raw as { at?: unknown; version?: unknown } | null;
    return r && typeof r.at === "number" && typeof r.version === "string" ? { at: r.at, version: r.version } : null;
  }
  async safetyClaude(this: AgentManagerPlugin, force = false): Promise<ClaudeFound | { error: string }> {
    const cached = this._safetyClaude;
    if (!force && cached && Date.now() - cached.at < VERSION_MS) return cached.found;
    const vault = path.resolve(this.getVaultPath());
    const launch = await this.terminal?.agentProgram("claude", vault);
    if (!launch) return { error: "The terminal isn't loaded yet." };
    if ("error" in launch) return { error: `Claude Code can't be found: ${launch.error}` };
    const env = scheduledEnv(launch.env);
    let real = launch.program;
    try { real = fs.realpathSync(launch.program); } catch { /* empty */ }
    const out = await new Promise<string>((resolve) => {
      import_child_process.execFile(launch.program, ["--version"], { env, cwd: os.tmpdir(), timeout: 15000, encoding: "utf8" }, (err, so) => resolve(err ? "" : String(so)));
    });
    const version = parseVersion(out);
    const found: ClaudeFound | { error: string } = version ? { program: launch.program, real, version, env } : { error: "Claude Code didn't say its version." };
    this._safetyClaude = { at: Date.now(), found };
    return found;
  }
  safetyNeverRead(this: AgentManagerPlugin): string[] {
    const home = os.homedir();
    const cfg = this.app.vault.configDir;
    return [...new Set([...NEVER_READ_HOME.map((p) => `${home}/${p}`), ...NEVER_READ_ANYWHERE, `**/${cfg}/**`])].sort();
  }
  safetyKeys(this: AgentManagerPlugin, c: ClaudeFound): Record<SafetyPhase, string> {
    const k = { program: c.real, version: c.version, plugin: this.manifest.version, neverRead: this.safetyNeverRead(), home: os.homedir() };
    const out = {} as Record<SafetyPhase, string>;
    for (const p of SAFETY_PHASES) out[p] = plannedKey(p, k);
    return out;
  }
  safetyNeeds(this: AgentManagerPlugin, v: TaskView): TaskNeeds {
    return { session: v.reach.mode === "full", shell: v.reach.shell, writes: v.reach.writesTo.length > 0, continues: v.reach.eachRun === "continue" };
  }
  async safetyGateFor(this: AgentManagerPlugin, v: TaskView): Promise<Gate> {
    if (!this.safetyAutoOn()) return { state: "ok" };
    const need = this.safetyNeeds(v);
    if (!phasesFor(need).length) return { state: "ok" };
    const c = await this.safetyClaude();
    if ("error" in c) return { state: "check", phases: phasesFor(need), why: `The run safety check can't tell which Claude Code runs would use: ${c.error}` };
    return safetyGate(need, this.safetyResults(), this.safetyKeys(c));
  }
  async safetyPhasesWanted(this: AgentManagerPlugin): Promise<SafetyPhase[]> {
    const want = new Set<SafetyPhase>(["locked", "shell"]);
    for (const v of await this.taskViews()) if (v.approved) for (const p of phasesFor(this.safetyNeeds(v))) want.add(p);
    return SAFETY_PHASES.filter((p) => want.has(p));
  }
  safetyAutoCheck(this: AgentManagerPlugin, phases: SafetyPhase[], keys: Record<SafetyPhase, string> | null): void {
    if (this._safetyRun || !phases.length || !keys) return;
    const results = this.safetyResults();
    const due = phases.filter((p) => {
      const r = results[p];
      if (!r || !keys || r.key !== keys[p]) return true;
      if (r.outcome === "failed" || r.outcome === "passed") return false;
      return Date.now() >= r.at + retryDelayMs(r.tries || 1);
    });
    if (due.length) void this.runSafetyCheck(due, { manual: false });
  }
  runSafetyCheck(this: AgentManagerPlugin, phases: SafetyPhase[], opts: { manual: boolean }): Promise<PhaseResult[]> {
    if (this._safetyRun) return this._safetyRun;
    const go = (async () => {
      this.refreshBrowsers();
      const c = await this.safetyClaude(true);
      const results: PhaseResult[] = [];
      if ("error" in c) {
        const at = Date.now();
        for (const p of phases) results.push({ phase: p, key: "", outcome: "couldn't run", why: c.error, cases: [], at, version: "", model: "" });
      } else {
        const keys = this.safetyKeys(c);
        const order = SAFETY_PHASES.filter((p) => phases.includes(p) || (p === "locked" && phases.includes("resume")));
        let lockedSession: { f: SafetyFixture & { homeTouch: string }; sessionId: string; model: string } | null = null;
        const scratch: string[] = [];
        this._safetyLastSession = undefined;
        try {
          for (const p of order) {
            if (this._unloading) break;
            let r: PhaseResult;
            const broke = (e: unknown): PhaseResult => ({ phase: p, key: keys[p], outcome: "couldn't run", why: `The check itself failed: ${e instanceof Error ? e.message : String(e)}`, cases: [], at: Date.now(), version: c.version, model: "" });
            if (p === "resume") {
              r = lockedSession ? await this._safetyPhase(c, p, keys[p], lockedSession).catch(broke) : { phase: p, key: keys[p], outcome: "couldn't run", why: "The locked-down run it continues didn't start.", cases: [], at: Date.now(), version: c.version, model: "" };
            } else {
              const f = this._makeSafetyFixture();
              if ("error" in f) { r = { phase: p, key: keys[p], outcome: "couldn't run", why: f.error, cases: [], at: Date.now(), version: c.version, model: "" }; }
              else {
                scratch.push(f.root);
                const sessionId = crypto.randomUUID();
                r = await this._safetyPhase(c, p, keys[p], { f, sessionId, model: CHECK_MODEL }).catch(broke);
                if (p === "locked" && r.outcome !== "couldn't run") lockedSession = { f, sessionId: this._safetyLastSession || sessionId, model: r.model === CHECK_MODEL ? CHECK_MODEL : "" };
              }
            }
            if (this._unloading) break;
            if (phases.includes(p)) results.push(this._saveSafetyResult(r));
          }
        } finally {
          for (const root of scratch) this._removeSafetyScratch(root);
        }
        if (!this._unloading) await this._writeSafetyNote(c, results);
      }
      if (!this._unloading) this._saySafety(results, opts.manual);
      return results;
    })().finally(() => { this._safetyRun = null; this._taskCache = null; this.refreshBrowsers(); });
    this._safetyRun = go;
    return go;
  }
  _makeSafetyFixture(this: AgentManagerPlugin): (SafetyFixture & { homeTouch: string }) | { error: string } {
    let root: string;
    try {
      root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "am-safety-check-")));
    } catch (e) { return { error: `Couldn't make a temporary folder: ${e instanceof Error ? e.message : String(e)}` }; }
    this._recordSafetyScratch(root, true);
    const vault = path.resolve(this.getVaultPath());
    const never = this.safetyNeverRead();
    const problem = fixtureProblem(root, (p) => neverReads(never, p)) || (root === vault || root.startsWith(vault + "/") || vault.startsWith(root + "/") ? `The temporary folder (${root}) is in the vault.` : "");
    if (problem) { this._removeSafetyScratch(root); return { error: problem }; }
    const f = safetyFixture(root, crypto.randomBytes(6).toString("hex"), os.homedir());
    try {
      for (const d of f.dirs) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      for (const x of f.files) fs.writeFileSync(x.path, x.text, { mode: 0o600 });
      for (const l of f.links) fs.symlinkSync(l.target, l.path);
      for (const x of f.files) if (fs.readFileSync(x.path, "utf8") !== x.text) throw new Error(`${x.path} didn't read back`);
      for (const l of f.links) if (fs.readlinkSync(l.path) !== l.target) throw new Error(`${l.path} isn't the link made`);
      if (fs.existsSync(f.homeTouch)) throw new Error(`${f.homeTouch} already exists`);
    } catch (e) {
      this._removeSafetyScratch(root);
      return { error: `Couldn't make the check's files: ${e instanceof Error ? e.message : String(e)}` };
    }
    return f;
  }
  _recordSafetyScratch(this: AgentManagerPlugin, root: string, add: boolean): void {
    let list: string[] = [];
    try { const raw: unknown = this.app.loadLocalStorage(SCRATCH_KEY); if (Array.isArray(raw)) list = (raw as unknown[]).filter((x): x is string => typeof x === "string"); } catch { /* empty */ }
    list = add ? [...new Set([...list, root])] : list.filter((x) => x !== root);
    try { this.app.saveLocalStorage(SCRATCH_KEY, list); } catch { /* empty */ }
  }
  _removeSafetyScratch(this: AgentManagerPlugin, root: string): void {
    let tmp = "";
    try { tmp = fs.realpathSync(os.tmpdir()); } catch { /* empty */ }
    if (tmp && path.dirname(root) === tmp && /^am-safety-check-[\w]+$/.test(path.basename(root))) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* empty */ }
    }
    this._recordSafetyScratch(root, false);
  }
  cleanupSafetyScratch(this: AgentManagerPlugin): void {
    let list: unknown = null;
    try { list = this.app.loadLocalStorage(SCRATCH_KEY); } catch { /* empty */ }
    if (Array.isArray(list)) for (const r of list) if (typeof r === "string") this._removeSafetyScratch(r);
  }
  async _safetyPhase(this: AgentManagerPlugin, c: ClaudeFound, phase: SafetyPhase, key: string, s: { f: SafetyFixture & { homeTouch: string }; sessionId: string; model: string }): Promise<PhaseResult> {
    const { f } = s;
    const home = os.homedir();
    const neverRead = this.safetyNeverRead();
    const at = Date.now();
    const fail = (why: string): PhaseResult => ({ phase, key, outcome: "couldn't run", why, cases: [], at, version: c.version, model: s.model });
    const shell = phase === "shell" || phase === "writes";
    const env = shell ? { ...c.env, GIT_CONFIG_GLOBAL: "/dev/null" } : c.env;
    if (shell && this.managedClaudeSettings()) {
      return fail(`this computer has Claude Code managed settings (${this.managedClaudeSettings()}), so shell tasks don't run here and the shell isn't checked`);
    }
    let model = s.model;
    const argvFor = (sessionId: string, resume?: string) => ({ f, phase, neverRead, model, home, sessionId, resume });
    const first = phase === "resume" ? argvFor(crypto.randomUUID(), s.sessionId) : argvFor(s.sessionId);
    if (!argvMatchesReal(first)) return fail("The check's command line isn't a real run's (a bug in the plugin).");
    let controlFired: boolean | null = null;
    if (phase !== "resume") {
      const ctl = await this._spawnSafety(c.program, controlArgs(first), { ...env, CLAUDE_CONFIG_DIR: f.config }, f.task, "hi", CONTROL_MS);
      const cc = collectStream(ctl.stream);
      const signedOut = !cc.uses.length && /not logged in|\/login|log ?in/i.test(`${cc.result?.text || ""} ${ctl.stderr}`);
      controlFired = signedOut && fs.existsSync(f.markers.controlHook);
    }
    if (this._unloading) return fail("Obsidian closed or the plugin reloaded during the check.");
    let run = await this._spawnSafety(c.program, safetyArgs(first), env, f.task, safetyPrompt(f, phase), RUN_MS);
    let col = collectStream(run.stream);
    let why = couldntRun(col, run.exitCode, run.stderr, run.spawnError);
    if (why && model && modelUnavailable(`${col.result?.text || ""} ${run.stderr}`)) {
      model = "";
      const again = phase === "resume" ? argvFor(crypto.randomUUID(), s.sessionId) : argvFor(crypto.randomUUID());
      run = await this._spawnSafety(c.program, safetyArgs(again), env, f.task, safetyPrompt(f, phase), RUN_MS);
      col = collectStream(run.stream);
      why = couldntRun(col, run.exitCode, run.stderr, run.spawnError);
      if (!why && phase === "locked") this._safetyLastSession = again.sessionId;
    } else if (phase === "locked") this._safetyLastSession = first.sessionId;
    const disk = { exists: (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } }, read: (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } } };
    if (why && !col.inits.length) {
      const kind = runFailureKind(why, run.stderr);
      return fail(kind === "login" ? "Claude's login expired: log in again in any Claude tab" : kind === "usage" ? `Usage limit: ${why}` : why);
    }
    if (col.version && col.version !== c.version) return fail(`Claude Code changed version during the check (${c.version} to ${col.version})`);
    let cases = judgePhase({ f, phase, c: col, disk, controlFired });
    if (why && !cases.some((x) => x.result === "fail")) return fail(why);
    const again = retrySteps(phase, cases);
    if (again.length && !cases.some((x) => x.result === "fail") && !this._unloading) {
      const retryArgv = phase === "resume" ? argvFor(crypto.randomUUID(), s.sessionId) : argvFor(crypto.randomUUID());
      const retry = await this._spawnSafety(c.program, safetyArgs(retryArgv), env, f.task, safetyPrompt(f, phase, again), RUN_MS);
      const rc = collectStream(retry.stream);
      if (!couldntRun(rc, retry.exitCode, retry.stderr, retry.spawnError)) {
        cases = mergeRetry(cases, judgePhase({ f, phase, c: rc, disk, controlFired }));
      }
    }
    for (const p of [f.homeTouch, f.markers.touchWritable]) { try { if (fs.lstatSync(p)) fs.rmSync(p, { force: true }); } catch { /* empty */ } }
    let outcome = phaseOutcome(cases);
    const managed = outcome === "failed" ? this.managedClaudeSettings() : "";
    return { phase, key, outcome, why: managed ? `this computer has Claude Code managed settings (${managed}), which may be why` : outcome === "inconclusive" ? "a case wasn't tried, even after a retry" : "", cases, at, version: c.version, model: model || "the account's default" };
  }
  _spawnSafety(this: AgentManagerPlugin, program: string, args: string[], env: Record<string, string>, cwd: string, input: string, ms: number): Promise<Spawned> {
    if (this._unloading) return Promise.resolve({ stream: "", stderr: "", exitCode: null, spawnError: "Obsidian closed or the plugin reloaded." });
    return new Promise((resolve) => {
      let stream = "", stderr = "", ended = false, spawnError = "";
      let child: ReturnType<typeof import_child_process.spawn> | null = null;
      try { child = import_child_process.spawn(program, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { spawnError = e instanceof Error ? e.message : String(e); }
      if (!child || !child.pid) { resolve({ stream, stderr, exitCode: null, spawnError: spawnError || "The process didn't start." }); return; }
      const pid = child.pid;
      (this._safetyPids || (this._safetyPids = new Set())).add(pid);
      void this._addRunRecord(pid, { folder: "", started: runStarted(new Date()), runRel: "" }).then(() => { if (ended) this._dropRunRecord(pid); });
      const timer = this.scheduleTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* empty */ } }, ms);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => { if (stream.length < 4e6) stream += d; });
      child.stderr?.on("data", (d: string) => { stderr = (stderr + d).slice(-8000); });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
      const done = (code: number | null) => {
        if (ended) return;
        ended = true;
        this.cancelTimeout(timer);
        if (code !== 0) { try { process.kill(-pid, "SIGKILL"); } catch { /* empty */ } }
        this._safetyPids?.delete(pid);
        this._dropRunRecord(pid);
        resolve({ stream, stderr, exitCode: code, spawnError });
      };
      child.on("error", (e) => { spawnError = spawnError || e.message; done(null); });
      child.on("close", (code) => done(code));
    });
  }
  async _writeSafetyNote(this: AgentManagerPlugin, c: ClaudeFound, fresh: PhaseResult[]): Promise<void> {
    if (!fresh.length) return;
    const notePath = (0, import_obsidian.normalizePath)(`${this.scheduledFolder()}/${SAFETY_NOTE}`);
    const saved = this.safetyResults();
    const results = SAFETY_PHASES.map((p) => saved[p]).filter((r): r is PhaseResult => !!r);
    const shown = SAFETY_PHASES.filter((p) => saved[p]);
    const section = safetySection({ machine: this.machineName(), when: runStarted(new Date(Math.max(...fresh.map((r) => r.at)))), version: c.version, program: c.real, plugin: this.manifest.version, results, all: shown, fmt: (ms) => runStarted(new Date(ms)), lastPass: this.safetyLastPass() });
    try {
      await this.ensureFolder(path.posix.dirname(notePath) === "." ? "" : path.posix.dirname(notePath));
      const adapter = this.app.vault.adapter;
      const existing = (await adapter.exists(notePath)) ? await adapter.read(notePath) : null;
      const text = safetyNoteText(existing, section, this.machineName());
      if (existing == null) await this.app.vault.create(notePath, text); else await adapter.write(notePath, text);
      if (this.schedSettings().commitRuns) {
        const outcome = fresh.every((r) => r.outcome === "passed") ? "passed" : fresh.some((r) => r.outcome === "failed") ? "failed" : "not conclusive";
        await this.commitPaths([notePath], `Agent Manager: run safety check on ${this.machineName()}, Claude Code ${c.version}, ${outcome}`);
      }
    } catch (e) { console.error("[Agent Manager] run safety note failed:", e); }
  }
  _saySafety(this: AgentManagerPlugin, results: (PhaseResult & { tries?: number })[], manual: boolean): void {
    const failed = results.filter((r) => r.outcome === "failed");
    const unsure = results.filter((r) => r.outcome === "couldn't run" || r.outcome === "inconclusive");
    const held = (p: SafetyPhase) => (p === "locked" ? "every headless task" : p === "resume" ? "tasks that continue their session" : p === "writes" ? "shell tasks with writes" : "shell tasks");
    if (failed.length) {
      const r = failed[0];
      const c = r.cases.find((x) => x.result === "fail");
      const body = `${PHASE_LABEL[r.phase]}: ${c ? c.label : r.why}.${this.safetyAutoOn() ? ` Held: ${failed.map((x) => held(x.phase)).join(", ")}, until a check passes.` : ""}`;
      this.notifyDesktop("Run safety check failed", body, "");
      return;
    }
    if (unsure.length) {
      const body = `${PHASE_LABEL[unsure[0].phase]}: ${unsure[0].outcome}${unsure[0].why ? `, ${unsure[0].why}` : ""}.`;
      if (manual) this.notifyDesktop("Run safety check didn't finish", body, "");
      else if ((unsure[0].tries || 1) === 1) this.notifyDesktop("Run safety check didn't finish", `${body} Scheduled runs wait; it tries again later.`, "");
      return;
    }
    if (manual) notice(`Agent Manager: the run safety check passed (${results.map((r) => PHASE_LABEL[r.phase]).join(", ")}).`);
  }
  async safetyStatus(this: AgentManagerPlugin): Promise<{ text: string; tone: "info" | "warn" | "bad"; action: string } | null> {
    if (this._safetyRun) return { text: "Checking run safety…", tone: "info", action: "" };
    const results = this.safetyResults();
    const any = SAFETY_PHASES.map((p) => results[p]).filter((r): r is PhaseResult => !!r);
    if (!this.safetyAutoOn() && !any.length) return null;
    const c = await this.safetyClaude();
    if ("error" in c) return null;
    const keys = this.safetyKeys(c);
    if (this.safetyAutoOn()) {
      const views = (await this.taskViews()).filter((v) => v.approved && !v.task.paused);
      const gates = views.map((v) => safetyGate(this.safetyNeeds(v), results, keys));
      const held = gates.find((g): g is Extract<Gate, { state: "held" }> => g.state === "held");
      if (held) return { text: `Run safety check failed (${PHASE_LABEL[held.phase]}), so ${gates.filter((g) => g.state === "held").length === 1 ? "a task is" : "tasks are"} held.`, tone: "bad", action: "Check again" };
      const failed = SAFETY_PHASES.map((p) => results[p]).find((r) => r && r.key === keys[r.phase] && r.outcome === "failed");
      if (failed) return { text: `Run safety check failed (${PHASE_LABEL[failed.phase]}); no approved task needs it now.`, tone: "warn", action: "Check again" };
      const waiting = gates.some((g) => g.state === "check");
      if (waiting) return { text: `Scheduled runs wait for the run safety check on Claude Code ${c.version}.`, tone: "warn", action: "Check now" };
      return null;
    }
    const last = any.filter((r) => r.outcome === "passed").sort((a, b) => b.at - a.at)[0] || any.sort((a, b) => b.at - a.at)[0];
    if (last && last.version && last.version !== c.version) return { text: `Claude Code updated to ${c.version} since the last run safety check (${last.version}).`, tone: "warn", action: "Check now" };
    return null;
  }
  async safetyBeforeRunNow(this: AgentManagerPlugin, v: TaskView): Promise<boolean> {
    let gate = await this.safetyGateFor(v);
    if (gate.state === "check") {
      notice("Agent Manager: checking run safety first (a short Haiku run for each phase it needs)…");
      await this.runSafetyCheck(gate.phases, { manual: false });
      gate = await this.safetyGateFor(v);
    }
    if (gate.state === "ok") return true;
    return this.askConfirm(`Run “${v.task.name}” anyway?`, `${gate.why} A run now would go ahead without a passing check on this Claude Code.`, "Run anyway");
  }
}
export { SafetyMethods };
