// Finding Python, the login shell, the user's PATH, and claude, for an app
// started from the Dock with launchd's minimal environment. Nothing here
// blocks the renderer, and nothing ever runs /usr/bin/python3: on a Mac
// without the developer tools it's a stub that opens an install prompt.

import { execFile, spawn } from "child_process";
import { constants, promises as fs } from "fs";
import { homedir, userInfo } from "os";
// Node's timers, not the window's: this also runs in the Node test harness, which has no window.
import { clearTimeout, setTimeout } from "timers";
import { delimiter, dirname, isAbsolute, join, normalize } from "path";

const PYTHON_PROBE_MS = 5000;
const PATH_PROBE_MS = 10000;
const MIN_PYTHON: [number, number] = [3, 8];
// Imports what the helper needs, so a Python missing a module is passed over.
const PYTHON_PROBE = "import sys,pty,fcntl,termios,selectors,ctypes,json;print('%d.%d' % sys.version_info[:2])";
const STUBS = new Set(["/usr/bin/python3", "/usr/bin/python"]);
const DEVELOPER_PYTHONS = [
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
];

export class NotFoundError extends Error {
  constructor(message: string, readonly tried: string[]) {
    super(message);
  }
}

/** Expands a leading ~ and normalizes an absolute filesystem path from a setting. */
export function expandPath(p: string): string {
  const t = p.trim();
  if (!t) return "";
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
  // Not Obsidian's normalizePath: that's for vault-relative paths and strips the leading slash.
  return normalize(expanded);
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    await fs.access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(parent: string): Promise<string[]> {
  try {
    return (await fs.readdir(parent)).sort().reverse().map((d) => join(parent, d));
  } catch {
    return [];
  }
}

function probePython(candidate: string): Promise<string | null> {
  return new Promise((resolve) => {
    // SIGKILL, and a deadline of its own: a wrapper that ignores SIGTERM can't
    // leave the terminal waiting.
    const deadline = setTimeout(() => resolve(null), PYTHON_PROBE_MS + 1000);
    const child = execFile(candidate, ["-I", "-c", PYTHON_PROBE], { timeout: PYTHON_PROBE_MS, killSignal: "SIGKILL", env: { PATH: "/usr/bin:/bin" } }, (err, stdout) => {
      clearTimeout(deadline);
      if (err) return resolve(null);
      const [maj, min] = stdout.trim().split(".").map(Number);
      const ok = maj > MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min >= MIN_PYTHON[1]);
      resolve(ok ? `${maj}.${min}` : null);
    });
    child.on("error", () => {});
  });
}

/**
 * Whether a path is, or leads by symlink to, the /usr/bin placeholder, and
 * the developer tools that make it a real Python aren't installed.
 */
async function isStub(p: string): Promise<boolean> {
  let real = p;
  try {
    real = await fs.realpath(p);
  } catch {
    // missing; isExecutable reports it
  }
  if (!STUBS.has(p) && !STUBS.has(real)) return false;
  for (const dev of DEVELOPER_PYTHONS) if (await isExecutable(dev)) return false;
  return true;
}

async function pythonCandidates(setting: string, pathDirs: string[]): Promise<string[]> {
  // A location the user set is the only one tried, so a mistake there is
  // reported rather than quietly passed over.
  if (setting) return [expandPath(setting)];
  const home = homedir();
  const list: string[] = [];
  list.push(
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
    "/opt/local/bin/python3",
  );
  for (const v of await listDirs(join(home, ".pyenv/versions"))) list.push(join(v, "bin/python3"));
  for (const v of await listDirs(join(home, ".local/share/uv/python"))) list.push(join(v, "bin/python3"));
  for (const d of ["miniconda3", "anaconda3", "miniforge3", "mambaforge"]) list.push(join(home, d, "bin/python3"));
  list.push(join(home, ".local/bin/python3"));
  for (const dir of pathDirs) list.push(join(dir, "python3"));
  // The developer tools' own Python, by path, only when it's really there.
  list.push(...DEVELOPER_PYTHONS);
  const seen = new Set<string>();
  const kept = list.filter((p) => {
    if (STUBS.has(p) || p.includes("/.pyenv/shims/") || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  // A symlink elsewhere can lead to the placeholder, too.
  const stubs = await Promise.all(kept.map(async (p) => STUBS.has(await fs.realpath(p).catch(() => p))));
  return kept.filter((_, i) => !stubs[i]);
}

/** The first usable Python 3. Never runs the /usr/bin stub. */
export async function findPython(setting: string, pathDirs: string[]): Promise<{ path: string; version: string }> {
  const tried: string[] = [];
  for (const candidate of await pythonCandidates(setting, pathDirs)) {
    if (!(await isExecutable(candidate))) {
      if (setting) tried.push(`${candidate} (not found)`);
      continue;
    }
    if (setting && (await isStub(candidate))) {
      tried.push(`${candidate} (the macOS placeholder; the developer tools aren't installed)`);
      continue;
    }
    tried.push(candidate);
    const version = await probePython(candidate);
    if (version) return { path: candidate, version };
  }
  throw new NotFoundError("Python 3 not found", tried);
}

/** The user's login shell from the account record, which a Dock launch doesn't put in $SHELL reliably. */
export function loginShell(setting: string): string {
  const fromSetting = expandPath(setting);
  if (fromSetting) return fromSetting;
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // no account record
  }
  return process.env.SHELL || "/bin/zsh";
}

/** The PATH the login shell's startup files build (probeLoginEnv). */
export async function probeLoginPath(shell: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  const path = (await probeLoginEnv(shell, env, signal)).PATH ?? "";
  if (!path.trim()) throw new Error("the login shell reported an empty PATH");
  return path.trim();
}

/** The end of the probe's answer: no "=", so it's never read as a variable. */
const PROBE_DONE = "VAULT_TERMINAL_PROBE_DONE";

/**
 * Asks the login shell for the environment its startup files build. The answer comes
 * back on fd 3, so whatever the startup files print can't corrupt it, and the
 * probe runs in its own process group so a timeout ends anything it started
 * (a sleep in a startup file would otherwise hold fd 3 open). The answer
 * ends with a marker, and is used as soon as the marker arrives: a job a
 * startup file leaves running in the background keeps fd 3 open, so the
 * pipe's end can be long in coming.
 */
export function probeLoginEnv(shell: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Record<string, string>> {
  // env -0: each variable ends in a NUL, so values with newlines come back whole.
  const script = `/usr/bin/env -0 >&3; printf '%s\\0' ${PROBE_DONE} >&3`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    // A watchdog in the probe's own group ends it if Obsidian dies before
    // the timeout below can: nothing in the renderer is left to do it then.
    // It lets go of fd 3, so the answer's end isn't held up by it.
    const watchdog = `(sleep ${PATH_PROBE_MS / 1000 + 5}; kill -9 0) </dev/null >/dev/null 2>&1 3>&- & exec "$0" -l -i -c "$1"`;
    const child = spawn("/bin/sh", ["-c", watchdog, shell, script], {
      cwd: homedir(),
      env: { ...env, VAULT_TERMINAL_ENV_PROBE: "1" },
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      detached: true,
    });
    let out = "";
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      const vars: Record<string, string> = {};
      for (const entry of out.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      if (err) reject(err);
      else if (!Object.keys(vars).length) reject(new Error("the login shell reported no environment"));
      else resolve(vars);
    };
    const timer = setTimeout(() => finish(new Error(`the login shell took longer than ${PATH_PROBE_MS / 1000} s`)), PATH_PROBE_MS);
    // The plugin unloading ends the probe and its shell at once.
    signal?.addEventListener("abort", () => finish(new Error("stopped")), { once: true });
    const pipe = child.stdio[3] as NodeJS.ReadableStream;
    pipe.setEncoding("utf8");
    pipe.on("data", (s: string) => {
      out += s;
      if (out.endsWith(`\0${PROBE_DONE}\0`)) finish(null);
    });
    pipe.on("end", () => finish(null));
    pipe.on("error", () => {});
    child.on("error", (e) => finish(e));
  });
}

/** A PATH that works before the login shell has answered: path_helper's plus the usual folders. */
export function fallbackPath(): Promise<string> {
  const home = homedir();
  const extra = [
    join(home, ".local/bin"),
    join(home, ".claude/local"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  return new Promise((resolve) => {
    execFile("/usr/libexec/path_helper", ["-s"], { timeout: 2000 }, (err, stdout) => {
      const m = !err && /PATH="([^"]*)"/.exec(stdout);
      const base = m ? m[1] : process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
      resolve(mergePath(extra.join(delimiter), base));
    });
  });
}

// What the probe's shell says about itself, not about the user's setup.
const PROBE_ONLY = /^(VAULT_TERMINAL_ENV_PROBE|SHLVL|_|PWD|OLDPWD)$/;

/**
 * An agent's environment: the app's own (programEnv),
 * then what the login shell's startup files set on top, then the user's own
 * NAME=value lines from the settings on top of both, and PWD the folder the
 * agent starts in. path is the PATH: the login shell's, when it has answered
 * (with node's folder added for a node script that needs it). The probe
 * starts from the app's own variables, so one missing from its answer was
 * unset by a startup file, and is left out here too.
 */
/**
 * The variables an agent gets: the login shell's, then the setting's own
 * (extra), then PATH and PWD; last, the names in strip are taken out, after
 * the setting's own are merged, so a key in a startup file or the setting
 * never reaches the agent (a host's list, such as Agent Manager's API keys).
 */
export function agentEnv(path: string, login: Record<string, string> | null, extra: string, cwd: string, strip: readonly string[] = []): NodeJS.ProcessEnv {
  const overlay: Record<string, string> = {};
  for (const [k, v] of Object.entries(login ?? {})) if (!PROBE_ONLY.test(k)) overlay[k] = v;
  const own = parseVariables(extra);
  for (const [k, v] of own) overlay[k] = v;
  const env = programEnv(path, overlay);
  if (login) for (const k of Object.keys(process.env)) if (!(k in login) && !(k in overlay) && !PROBE_ONLY.test(k) && !/^(PATH|HOME|TERM|COLORTERM|LANG)$/.test(k)) delete env[k];
  // A PATH of the user's own wins over the login shell's too.
  for (const [k, v] of own) if (k === "PATH") env.PATH = v;
  env.PWD = cwd;
  // PATH and PWD are the terminal's own: never taken out.
  for (const k of strip) if (k !== "PATH" && k !== "PWD") delete env[k];
  return env;
}

/**
 * What agents never get from the login shell or the settings, by default:
 * API keys and the switches that move Claude to another
 * provider. A key in .zshrc would otherwise quietly move Claude onto API
 * billing or another provider.
 */
export const DEFAULT_STRIPPED_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
].join("\n");

/** Variable names, one per line or separated by spaces or commas; # comments and names a shell couldn't export skipped. */
export function parseNames(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    for (const name of line.split(/[\s,]+/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** NAME=value lines; blank lines and # comments skipped, and names a shell couldn't export ignored. */
export function parseVariables(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) out.push([name, line.slice(eq + 1)]);
  }
  return out;
}

export function mergePath(...paths: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    for (const dir of p.split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
  }
  return out.join(delimiter);
}

/** Splits a command setting into words, honoring single and double quotes and backslashes. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/**
 * Resolves the first word of the claude command: the location setting, then
 * PATH, then the places claude's installers use.
 */
export async function findProgram(name: string, locationSetting: string, path: string): Promise<string> {
  const tried: string[] = [];
  const check = async (p: string) => {
    tried.push(p);
    return isExecutable(p);
  };
  const location = expandPath(locationSetting);
  if (location && (await check(location))) return location;
  if (isAbsolute(name) || name.includes("/")) {
    const p = expandPath(name);
    if (await check(p)) return p;
    throw new NotFoundError(`${name} not found`, tried);
  }
  for (const dir of path.split(delimiter)) {
    if (dir && (await check(join(dir, name)))) return join(dir, name);
  }
  const home = homedir();
  const known = [
    join(home, ".local/bin", name),
    join(home, ".claude/local", name),
    join("/opt/homebrew/bin", name),
    join("/usr/local/bin", name),
    join(home, ".npm-global/bin", name),
    join(home, ".volta/bin", name),
    join(home, ".bun/bin", name),
  ];
  for (const v of await listDirs(join(home, ".nvm/versions/node"))) known.push(join(v, "bin", name));
  for (const p of known) if (await check(p)) return p;
  throw new NotFoundError(`${name} not found`, tried);
}

/**
 * If the program is a script run by `env node`, the node it needs must be on
 * PATH; when it sits beside the script (npm's layout), make sure that folder is.
 */
export async function pathForScript(program: string, path: string): Promise<string> {
  try {
    const fh = await fs.open(program, "r");
    const buf = Buffer.alloc(128);
    await fh.read(buf, 0, 128, 0);
    await fh.close();
    const first = buf.toString("utf8").split("\n")[0];
    if (!first.startsWith("#!") || !/\bnode\b/.test(first)) return path;
    // npm puts the link to the script beside the node that installed it.
    for (const dir of [dirname(program), dirname(await fs.realpath(program))]) {
      if (await isExecutable(join(dir, "node"))) return mergePath(normalize(dir), path);
    }
  } catch {
    // unreadable; leave PATH alone
  }
  return path;
}

/**
 * The environment a terminal's program gets: the GUI app's own, minus what
 * belongs to Electron or to whatever terminal launched Obsidian (its LINES
 * and COLUMNS would override the pty's size), plus the recovered PATH and the
 * terminal's identity.
 */
export function programEnv(path: string, overlay: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...process.env, ...overlay })) {
    if (/^(ELECTRON_|CHROME_|TERM_PROGRAM|TERM_SESSION_ID$|ITERM_|VSCODE_|__CFBundleIdentifier$|VAULT_TERMINAL_|LINES$|COLUMNS$)/.test(k)) continue;
    env[k] = v;
  }
  env.PATH = path;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  if (!env.HOME) env.HOME = homedir();
  return env;
}

/**
 * Settings for one claude session, passed with --settings (values there
 * override the user's settings files for that session only, never changing
 * them). Each key is added only where the command doesn't set it itself: a
 * command with its own inline --settings JSON gets the missing keys merged
 * in; one that points --settings at a file is left alone, since the two
 * can't be merged here.
 */
export function withSessionSettings(words: string[], extra: Record<string, unknown>): void {
  if (!Object.keys(extra).length) return;
  const i = words.findIndex((w) => w === "--settings" || w.startsWith("--settings="));
  if (i < 0) {
    words.push("--settings", JSON.stringify(extra));
    return;
  }
  const inline = words[i] === "--settings";
  const value = inline ? words[i + 1] ?? "" : words[i].slice("--settings=".length);
  const settings = inlineSettings(value);
  if (!settings) return;
  const missing = Object.entries(extra).filter(([k]) => !(k in settings));
  // Hooks add to the command's own, event by event: both run.
  const hooks = mergedHooks(settings.hooks, extra.hooks);
  if (!missing.length && !hooks) return;
  const merged = JSON.stringify({ ...settings, ...Object.fromEntries(missing), ...(hooks ? { hooks } : {}) });
  if (inline) words[i + 1] = merged;
  else words[i] = `--settings=${merged}`;
}

/** The command's own hooks with ours added; null when there's nothing to merge. */
function mergedHooks(theirs: unknown, ours: unknown): Record<string, unknown> | null {
  if (!theirs || !ours || typeof theirs !== "object" || typeof ours !== "object" || Array.isArray(theirs)) return null;
  const merged: Record<string, unknown> = { ...(theirs as Record<string, unknown>) };
  for (const [event, list] of Object.entries(ours as Record<string, unknown[]>)) {
    const own = merged[event];
    merged[event] = Array.isArray(own) ? [...(own as unknown[]), ...list] : list;
  }
  return merged;
}

/** A --settings value that's inline JSON, parsed; null for a file path or JSON claude wouldn't accept either. */
export function inlineSettings(value: string): Record<string, unknown> | null {
  if (!value.trim().startsWith("{")) return null;
  try {
    const settings = JSON.parse(value) as unknown;
    return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * claude notifies only terminals it recognizes unless told a channel. Kitty's
 * (OSC 99) says what claude needs, which the tab shows. Set for this session
 * only, unless the command names a channel itself.
 */
export function withNotificationChannel(words: string[]): void {
  withSessionSettings(words, { preferredNotifChannel: "kitty" });
}
