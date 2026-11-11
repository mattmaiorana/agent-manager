
import { execFile, spawn } from "child_process";
import { constants, promises as fs } from "fs";
import { homedir, userInfo } from "os";
import { clearTimeout, setTimeout } from "timers";
import { delimiter, dirname, isAbsolute, join, normalize } from "path";

const PYTHON_PROBE_MS = 5000;
const PATH_PROBE_MS = 10000;
const MIN_PYTHON: [number, number] = [3, 8];
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

export function expandPath(p: string): string {
  const t = p.trim();
  if (!t) return "";
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
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

async function isStub(p: string): Promise<boolean> {
  let real = p;
  try {
    real = await fs.realpath(p);
  } catch {
    /* empty */
  }
  if (!STUBS.has(p) && !STUBS.has(real)) return false;
  for (const dev of DEVELOPER_PYTHONS) if (await isExecutable(dev)) return false;
  return true;
}

async function pythonCandidates(setting: string, pathDirs: string[]): Promise<string[]> {
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
  list.push(...DEVELOPER_PYTHONS);
  const seen = new Set<string>();
  const kept = list.filter((p) => {
    if (STUBS.has(p) || p.includes("/.pyenv/shims/") || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  const stubs = await Promise.all(kept.map(async (p) => STUBS.has(await fs.realpath(p).catch(() => p))));
  return kept.filter((_, i) => !stubs[i]);
}

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

export function loginShell(setting: string): string {
  const fromSetting = expandPath(setting);
  if (fromSetting) return fromSetting;
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    /* empty */
  }
  return process.env.SHELL || "/bin/zsh";
}

export async function probeLoginPath(shell: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  const path = (await probeLoginEnv(shell, env, signal)).PATH ?? "";
  if (!path.trim()) throw new Error("the login shell reported an empty PATH");
  return path.trim();
}

const PROBE_DONE = "VAULT_TERMINAL_PROBE_DONE";

export function probeLoginEnv(shell: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Record<string, string>> {
  const script = `/usr/bin/env -0 >&3; printf '%s\\0' ${PROBE_DONE} >&3`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
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
        /* empty */
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

let fallbackPathOnce: Promise<string> | null = null;
export function fallbackPath(): Promise<string> {
  return (fallbackPathOnce ??= readFallbackPath());
}

function readFallbackPath(): Promise<string> {
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

const PROBE_ONLY = /^(VAULT_TERMINAL_ENV_PROBE|SHLVL|_|PWD|OLDPWD)$/;

export function agentEnv(path: string, login: Record<string, string> | null, extra: string, cwd: string, strip: readonly string[] = []): NodeJS.ProcessEnv {
  const overlay: Record<string, string> = {};
  for (const [k, v] of Object.entries(login ?? {})) if (!PROBE_ONLY.test(k)) overlay[k] = v;
  const own = parseVariables(extra);
  for (const [k, v] of own) overlay[k] = v;
  const env = programEnv(path, overlay);
  if (login) for (const k of Object.keys(process.env)) if (!(k in login) && !(k in overlay) && !PROBE_ONLY.test(k) && !/^(PATH|HOME|TERM|COLORTERM|LANG)$/.test(k)) delete env[k];
  for (const [k, v] of own) if (k === "PATH") env.PATH = v;
  env.PWD = cwd;
  for (const k of strip) if (k !== "PATH" && k !== "PWD") delete env[k];
  return env;
}

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

export function parseNames(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    for (const name of line.split(/[\s,]+/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

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

export async function pathForScript(program: string, path: string): Promise<string> {
  try {
    const fh = await fs.open(program, "r");
    const buf = Buffer.alloc(128);
    await fh.read(buf, 0, 128, 0);
    await fh.close();
    const first = buf.toString("utf8").split("\n")[0];
    if (!first.startsWith("#!") || !/\bnode\b/.test(first)) return path;
    for (const dir of [dirname(program), dirname(await fs.realpath(program))]) {
      if (await isExecutable(join(dir, "node"))) return mergePath(normalize(dir), path);
    }
  } catch {
    /* empty */
  }
  return path;
}

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

export function withSessionSettings(words: string[], extra: Record<string, unknown>): void {
  if (!Object.keys(extra).length) return;
  collapseSettings(words);
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
  const hooks = mergedHooks(settings.hooks, extra.hooks);
  if (!missing.length && !hooks) return;
  const merged = JSON.stringify({ ...settings, ...Object.fromEntries(missing), ...(hooks ? { hooks } : {}) });
  if (inline) words[i + 1] = merged;
  else words[i] = `--settings=${merged}`;
}

function collapseSettings(words: string[]): void {
  const at: { i: number; inline: boolean; value: Record<string, unknown> }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w !== "--settings" && !w.startsWith("--settings=")) continue;
    const inline = w === "--settings";
    const value = inlineSettings(inline ? words[i + 1] ?? "" : w.slice("--settings=".length));
    if (!value) return;
    at.push({ i, inline, value });
    if (inline) i++;
  }
  if (at.length < 2) return;
  let merged: Record<string, unknown> = {};
  for (const a of at) {
    const hooks = mergedHooks(merged.hooks, a.value.hooks);
    merged = { ...merged, ...a.value, ...(hooks ? { hooks } : {}) };
  }
  for (const a of at.slice(1).reverse()) words.splice(a.i, a.inline ? 2 : 1);
  const first = at[0];
  if (first.inline) words[first.i + 1] = JSON.stringify(merged);
  else words[first.i] = `--settings=${JSON.stringify(merged)}`;
}

function mergedHooks(theirs: unknown, ours: unknown): Record<string, unknown> | null {
  if (!theirs || !ours || typeof theirs !== "object" || typeof ours !== "object" || Array.isArray(theirs)) return null;
  const merged: Record<string, unknown> = { ...(theirs as Record<string, unknown>) };
  for (const [event, list] of Object.entries(ours as Record<string, unknown[]>)) {
    const own = merged[event];
    merged[event] = Array.isArray(own) ? [...(own as unknown[]), ...list] : list;
  }
  return merged;
}

export function inlineSettings(value: string): Record<string, unknown> | null {
  if (!value.trim().startsWith("{")) return null;
  try {
    const settings = JSON.parse(value) as unknown;
    return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function withNotificationChannel(words: string[]): void {
  withSessionSettings(words, { preferredNotifChannel: "kitty" });
}
