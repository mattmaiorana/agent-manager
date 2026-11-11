
import { NEVER_READ_ANYWHERE, NEVER_READ_HOME, GATHER_HEADING, GATHER_MAX, HUMAN_NOTES_HEADING, OUTPUTS_FOLDER, PROMPT_HEADING, RUN_LOG_FILE, TASK_MEMORY_FILE, SCHEDULED_BACKENDS, SCHEDULED_EXTRA_TOOLS, SCHEDULED_TYPE, SESSION_DENY_TOOLS, TASK_PROPS } from "../constants/scheduled.js";
import type { TaskEachRun, TaskFiles, TaskMode } from "../constants/scheduled.js";
import { isArchived as isArchivedPath } from "../util/paths.js";
import { emptyContext, readsOf } from "../context/launch-context.js";
import type { ContextVault } from "../context/launch-context.js";
import { runGatherCommands } from "./run-core.js";
import { schedMinGap, schedParse } from "./schedule-core.js";
import type { SchedParsed } from "./schedule-core.js";

export interface ScheduledTask {
  name: string;
  folder: string;
  notePath: string;
  label: string;
  archived: boolean;
  problems: string[];
  paused: boolean;
  backend: string;
  model: string;
  projectFolder: string | null;
  mode: TaskMode;
  web: { mode: "off" | "search" | "sites"; sites: string[]; listNote: string | null };
  connectors: "on" | "none";
  deny: string[];
  files: TaskFiles;
  folders: string[];
  notes: string[];
  outside: string[];
  places: OutsidePlace[];
  tools: string[];
  eachRun: TaskEachRun;
  onlyWhenNew: boolean;
  catchUp: boolean;
  output: string;
  followUp: "" | "ticket";
  tab: "keep" | "close";
  shell: boolean;
  writes: string[];
  writePlaces: OutsidePlace[];
  scheduleText: string;
  rules: SchedParsed;
  prompt: string;
  humanNotes: string;
  readsResolved: string[];
  gather: string[];
}

export interface OutsidePlace { path: string; kind: "folder" }

export interface TaskVault {
  projectOf(taskFolder: string): string | null;
  isFolder(path: string): boolean;
  isFile(path: string): boolean;
  inOtherTask(path: string, own: string): boolean;
  siteListNote?(link: string, from: string): { path: string; text: string } | null;
  resolve?(link: string, from: string, asLink?: boolean): { path: string; folder: boolean } | null;
}

const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export function isTaskFrontmatter(fm: Record<string, unknown> | null | undefined): boolean {
  const t = fm?.type;
  return typeof t === "string" && t.trim().toLowerCase() === SCHEDULED_TYPE;
}

function plain(v: unknown): string {
  while (Array.isArray(v) && v.length === 1) v = v[0];
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") return "";
  const s = v.trim();
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(s);
  return (m ? m[1] : s).trim();
}
function listOf(v: unknown): string[] {
  if (v == null || v === "") return [];
  const items = Array.isArray(v) ? (v as unknown[]) : typeof v === "string" ? v.split(",") : [v];
  return items.map(plain).filter(Boolean);
}
function boolOf(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const s = plain(v).toLowerCase();
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  return null;
}
export function sectionText(body: string, heading: string): string {
  const text = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^##[ \\t]+${esc}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,2}[ \\t]|^---[ \\t]*$|(?![\\s\\S]))`, "m").exec(text);
  return (m ? m[1] : "").trim();
}
export function siteHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ? h : null;
}
export function webListLink(v: unknown): string | null {
  if (Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && (v[0] as unknown[]).length === 1 && typeof (v[0] as unknown[])[0] === "string") return String((v[0] as unknown[])[0]).trim() || null;
  const x = Array.isArray(v) && v.length === 1 ? (v[0] as unknown) : v;
  if (typeof x !== "string") return null;
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(x.trim());
  return m ? m[1].trim() : null;
}
export function sitesInNote(text: string): { sites: string[]; bad: string[] } {
  const sites: string[] = [], bad: string[] = [];
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^<(.*)>$/, "$1").trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    const h = siteHost(line);
    if (!h) bad.push(line.length > 60 ? `${line.slice(0, 60)}…` : line);
    else if (!sites.includes(h)) sites.push(h);
  }
  return { sites: sites.sort(), bad };
}
function vaultPath(raw: string, normalize: (p: string) => string): string | null {
  const p = normalize(raw.trim().replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!p || p === "/" || p.split("/").includes("..")) return null;
  return p;
}

const TEXT_NOTE = /\.(md|txt|csv|json|ya?ml)$/i;

export function readTask(input: { notePath: string; frontmatter: Record<string, unknown> | null; text: string | null }, vault: TaskVault, opts: { now: Date; configDir: string; normalize?: (p: string) => string }): ScheduledTask {
  const normalize = opts.normalize || ((p: string) => p.replace(/\/{2,}/g, "/"));
  const notePath = input.notePath;
  const folder = parentOf(notePath);
  const name = baseName(notePath).replace(/\.md$/i, "");
  const fm = input.frontmatter || {};
  const get = (k: keyof typeof TASK_PROPS): unknown => fm[TASK_PROPS[k]];
  const problems: string[] = [];
  const t: ScheduledTask = {
    name, label: name, folder, notePath, archived: isArchivedPath(notePath), problems,
    paused: true, backend: SCHEDULED_BACKENDS[0], model: "", projectFolder: vault.projectOf(folder),
    mode: "headless", web: { mode: "off", sites: [], listNote: null }, connectors: "none", deny: [], files: "project", folders: [], notes: [], outside: [], places: [], tools: [], eachRun: "new",
    onlyWhenNew: false, catchUp: true, output: "", followUp: "", tab: "keep", shell: false, writes: [], writePlaces: [], scheduleText: "",
    rules: { error: "No schedule set" }, prompt: "", humanNotes: "", readsResolved: [], gather: [],
  };
  if (t.archived) problems.push("It's archived, so it doesn't run.");
  if ([RUN_LOG_FILE, TASK_MEMORY_FILE].some((f) => f.replace(/\.md$/i, "").toLowerCase() === name.toLowerCase()) || /^memory \(proposed /i.test(name)) problems.push(`A task can't be called "${name}": the plugin keeps a file by that name in the task's folder. Rename it.`);
  if (!folder || baseName(folder) !== name) problems.push(`It needs a folder of its own with the same name: put it in a folder called "${name}".`);

  const paused = boolOf(get("paused"));
  t.paused = paused !== false;

  const backend = plain(get("backend")).toLowerCase();
  if (backend && !SCHEDULED_BACKENDS.includes(backend as typeof SCHEDULED_BACKENDS[number])) {
    problems.push(backend === "codex" ? "Scheduled tasks run on Claude Code for now: Codex comes in a later release. Set cli to claude, or leave it empty." : `"${backend}" can't run scheduled tasks: leave cli empty for Claude Code.`);
  } else if (backend) t.backend = backend;

  t.model = plain(get("model"));
  if (t.model && !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(t.model)) problems.push(`Its model "${t.model}" isn't a model name.`);

  const mode = plain(get("mode")).toLowerCase();
  if (mode === "full" || mode === "headless") t.mode = mode;
  else if (mode) problems.push(`Its mode "${mode}" isn't full (a full session) or headless.`);
  const session = t.mode === "full";
  if (get("unrestricted") != null && get("unrestricted") !== "" && boolOf(get("unrestricted")) !== false) problems.push("unrestricted is gone: set mode to full for a run as a full Claude Code session, and delete the unrestricted line.");

  const rawWeb = get("web");
  const linked = webListLink(rawWeb);
  const webItems = linked ? [] : listOf(rawWeb).map((x) => x.toLowerCase());
  if (linked) {
    const note = vault.siteListNote ? vault.siteListNote(linked, notePath) : null;
    if (!note) problems.push(`Its web links "${linked}", which isn't a note in this vault.`);
    else {
      const { sites, bad } = sitesInNote(note.text);
      for (const b of bad) problems.push(`Its web list "${note.path}" has "${b}", which isn't a site's address.`);
      if (!sites.length && !bad.length) problems.push(`Its web list "${note.path}" names no sites.`);
      t.web = { mode: "sites", sites, listNote: note.path };
    }
  } else if (rawWeb === false || !webItems.length || (webItems.length === 1 && (webItems[0] === "off" || webItems[0] === "false" || webItems[0] === "none"))) {
    t.web = { mode: "off", sites: [], listNote: null };
  } else if (webItems.length === 1 && webItems[0] === "search") {
    t.web = { mode: "search", sites: [], listNote: null };
  } else if (webItems.includes("search")) {
    problems.push("Its web can be search or a list of sites, not both: search results can come from anywhere.");
  } else {
    const sites: string[] = [];
    for (const item of webItems) {
      const h = siteHost(item);
      if (!h) problems.push(`Its web names "${item}", which isn't a site's address.`);
      else if (!sites.includes(h)) sites.push(h);
    }
    t.web = { mode: "sites", sites, listNote: null };
  }
  const online = t.web.mode !== "off";

  {
    const rctx = emptyContext();
    const cv: ContextVault = {
      isNote: () => false, frontmatter: () => fm,
      resolve: vault.resolve ? (l, from, asLink) => vault.resolve!(l, from, asLink) : (l) => {
        const p = vaultPath(l, normalize);
        if (!p) return null;
        if (vault.isFolder(p)) return { path: p, folder: true };
        if (vault.isFile(p)) return { path: p, folder: false };
        return vault.isFile(`${p}.md`) ? { path: `${p}.md`, folder: false } : null;
      },
    };
    readsOf(notePath, cv, rctx);
    t.readsResolved = rctx.reads.map((r) => (r.folder ? `${r.path.replace(/\/+$/, "")}/` : r.path));
    if (rctx.missingReads.length) problems.push(`Its reads name${rctx.missingReads.length === 1 ? "s" : ""} ${rctx.missingReads.join(", ")}, which ${rctx.missingReads.length === 1 ? "isn't" : "aren't"} in the vault.`);
    if (!session) for (const r of rctx.reads) {
      if (r.folder) { if (!t.folders.includes(r.path)) t.folders.push(r.path); }
      else if (!TEXT_NOTE.test(r.path)) problems.push(`Its reads names "${r.path}", which a headless run can't be given: only text notes (.md, .txt, .csv, .json, .yaml).`);
      else if (!t.notes.includes(r.path)) t.notes.push(r.path);
    }
  }
  const rawFiles = get("files");
  const fileItems = listOf(rawFiles);
  const word = fileItems.length === 1 ? fileItems[0].toLowerCase() : "";
  if (!fileItems.length) t.files = online ? "none" : "project";
  else if (word === "none" || word === "project" || word === "vault" || word === "disk") t.files = word;
  else {
    const scopes = fileItems.filter((f) => ["none", "project", "vault", "disk"].includes(f.toLowerCase())).map((f) => f.toLowerCase());
    const outside = fileItems.filter((f) => /^(~\/|\/)/.test(f.trim()));
    const inVault = fileItems.filter((f) => !scopes.includes(f.toLowerCase()) && !outside.includes(f));
    if (scopes.includes("disk")) problems.push("Its file-access can't list disk beside other places: disk already reads everything.");
    else if (scopes.filter((x) => x !== "none").length > 1) problems.push("Its file-access can name project or vault, not both.");
    t.files = scopes.includes("vault") ? "vault" : scopes.includes("project") ? "project" : "none";
    for (const f of inVault) problems.push(`Its file-access names "${f}": name vault notes and folders in reads, and keep file-access for none, project, vault, disk, or places outside the vault.`);
    for (const f of outside) {
      const w = f.trim();
      if (/[*?[\]{}!\\]/.test(w)) problems.push(`Its file-access names "${w}", which has a character Claude reads as a pattern (* ? [ ] { } ! or \\). Rename it, or name the folder it's in.`);
      else if (w.split("/").includes("..")) problems.push(`Its file-access names "${w}", which uses "..": write the place's own path.`);
      else if (!t.outside.includes(w)) t.outside.push(w);
    }
  }
  if (!session && online && (t.files === "project" || t.files === "vault" || t.files === "disk")) problems.push(`A task with the web reads only its own folder and the vault folders or notes its reads names, not ${t.files === "project" ? "its project" : t.files === "vault" ? "the whole vault" : "the whole disk"}: name what it needs in reads, or set web to off.`);
  if (!session && t.outside.length && online) problems.push("A task with the web can't read places outside the vault: set web to off, or drop the outside places.");

  t.tools = listOf(get("tools"));
  const refused = t.tools.filter((x) => !SCHEDULED_EXTRA_TOOLS.includes(x));
  if (refused.includes("WebSearch") || refused.includes("WebFetch")) problems.push("Its tools can't add web tools: set web to search, or to a list of sites.");
  else if (refused.length) problems.push(`Its tools can't add ${refused.join(", ")}: a scheduled run can add only ${SCHEDULED_EXTRA_TOOLS.join(", ")}.`);

  const eachRun = plain(get("eachRun")).toLowerCase();
  if (eachRun && eachRun !== "new" && eachRun !== "continue") problems.push(`Its each-run "${eachRun}" isn't new or continue.`);
  else if (eachRun) t.eachRun = eachRun as TaskEachRun;

  t.onlyWhenNew = boolOf(get("onlyWhenNew")) === true;
  t.catchUp = boolOf(get("catchUp")) !== false;

  const followUp = plain(get("followUp")).toLowerCase();
  if (followUp === "ticket") t.followUp = "ticket";
  else if (followUp && followUp !== "none" && followUp !== "off" && followUp !== "false") problems.push(`Its follow-up "${followUp}" isn't ticket or empty.`);
  const tab = plain(get("tab")).toLowerCase();
  if (tab === "close") t.tab = "close";
  else if (tab && tab !== "keep") problems.push(`Its tab "${tab}" isn't keep or close.`);

  t.shell = boolOf(get("shell")) === true;
  if (!session && t.shell && t.web.mode !== "off") problems.push("It can't have a shell and the web: set web to off, or shell to false.");
  for (const raw of listOf(get("writes"))) {
    const w = raw.trim();
    if (!/^(~\/|\/)/.test(w)) problems.push(`Its writes names "${w}": a folder it may change is outside the vault and starts with ~/ or /.`);
    else if (/[*?[\]{}!\\]/.test(w)) problems.push(`Its writes names "${w}", which has a character Claude reads as a pattern (* ? [ ] { } ! or \\). Rename it, or name the folder it's in.`);
    else if (w.split("/").includes("..")) problems.push(`Its writes names "${w}", which uses "..": write the place's own path.`);
    else if (!t.writes.includes(w)) t.writes.push(w);
  }
  if (!session && t.writes.length && !t.shell) problems.push("Its writes needs a shell: set shell to true (with web off), since only the shell can change files outside its run folder.");
  if (!session && t.shell && t.files === "disk") problems.push("It can't have a shell and file-access: disk: a shell reads the rest of this computer already. Set file-access to vault, project, or folders.");

  const rawSchedule = get("schedule");
  t.scheduleText = typeof rawSchedule === "string" ? rawSchedule.trim() : plain(rawSchedule);
  t.rules = schedParse(t.scheduleText);
  if ("error" in t.rules) problems.push(t.rules.error === "No schedule set" ? "It has no schedule." : `${t.rules.error}.`);

  const rawOutput = plain(get("output"));
  if (rawOutput) {
    const out = vaultPath(rawOutput, normalize);
    if (!out) problems.push("Its output must be a path inside the vault.");
    else {
      t.output = out;
      if (out === opts.configDir || out.startsWith(opts.configDir + "/")) problems.push(`Its output can't be inside ${opts.configDir}.`);
      else if (vault.inOtherTask(out, folder)) problems.push("Its output can't be inside another scheduled task.");
      else if (out.startsWith(`${folder}/${OUTPUTS_FOLDER}/`) && out.slice(folder.length + OUTPUTS_FOLDER.length + 2).includes("/")) problems.push(`Its output can't be in a folder inside its ${OUTPUTS_FOLDER} folder: leave output empty to file results there.`);
      if (!out.includes("{{date}}")) problems.push("Its output must include {{date}}, so each run makes a new file.");
      const gap = "error" in t.rules ? null : schedMinGap(t.rules, opts.now);
      if (gap != null && gap < 24 * 60 && !out.includes("{{time}}")) problems.push("It runs more than once a day, so its output must include {{time}} too.");
    }
  }

  const text = input.text || "";
  t.prompt = sectionText(text, PROMPT_HEADING);
  t.humanNotes = sectionText(text, HUMAN_NOTES_HEADING);
  if (!t.prompt) problems.push(`Its ## ${PROMPT_HEADING} section is empty.`);
  t.gather = runGatherCommands(sectionText(text, GATHER_HEADING));
  if (t.gather.length > GATHER_MAX) problems.push(`Its ## ${GATHER_HEADING} has ${t.gather.length} commands, and a task may have ${GATHER_MAX}: join some with ";" or "&&" on one line.`);
  if (t.gather.some((c) => /\{\{\s*\w+\s*\}\}/.test(c))) problems.push(`Its ## ${GATHER_HEADING} uses a {{...}} placeholder: write "$AM_VAULT", "$AM_TASK", or "$AM_SINCE" instead.`);

  const connectors = plain(get("connectors")).toLowerCase();
  if (connectors === "on" || connectors === "true") t.connectors = "on";
  else if (connectors && connectors !== "none" && connectors !== "off" && connectors !== "false") problems.push(`Its connectors "${connectors}" isn't on or none.`);
  for (const d of listOf(get("deny"))) {
    const name = SESSION_DENY_TOOLS.find((x) => x.toLowerCase() === d.toLowerCase());
    if (!name) problems.push(`Its deny names "${d}": a full session task can refuse ${SESSION_DENY_TOOLS.join(", ")}.`);
    else if (!t.deny.includes(name)) t.deny.push(name);
  }
  if (session) {
    const set = (k: keyof typeof TASK_PROPS) => { const v = get(k); return v != null && v !== "" && !(Array.isArray(v) && !v.length); };
    const headlessOnly = [set("files") && "file-access", set("shell") && "shell", set("writes") && "writes", set("tools") && "tools"].filter(Boolean);
    if (headlessOnly.length) problems.push(`A full session task can't set ${headlessOnly.join(", ")}: ${headlessOnly.length > 1 ? "they apply" : "it applies"} only to headless runs, and a session reads and writes as any session does. Delete ${headlessOnly.length > 1 ? "them" : "it"}, or set mode to headless.`);
    if (t.gather.length) problems.push(`A full session task doesn't use ## ${GATHER_HEADING}: the session runs what it needs. Move the commands into the prompt, or set mode to headless.`);
  } else {
    if (tab) problems.push("Its tab applies only to full session runs: a headless run has no tab. Delete it, or set mode to full.");
    if (connectors || t.deny.length) problems.push(`Its ${connectors ? "connectors" : "deny"} applies only to full session runs: a headless run has no connectors and only the tools it's given. Delete it, or set mode to full.`);
    if (online && t.gather.length) problems.push(`A task with the web can't have ## ${GATHER_HEADING}: make it a full session task, or set web to off.`);
  }
  return t;
}

export interface ReachEnv {
  vaultAbs: string;
  home: string;
  agent: { name: string; instructions: string | null } | null;
  overviews: string[];
  agentsFile: string | null;
  startAbs?: string;
  neverRead: string[];
  userNeverRead?: string[];
  transcriptsFolder: string;
  transcriptNotes?: string[];
  configDir: string;
  gatherFiles?: string[];
  otherTasks?: string[];
}

export interface ResolvedReach {
  backend: string;
  model: string;
  agent: string | null;
  web: { search: boolean; sites: string[]; rules: string[] };
  cwd: string;
  read: string[];
  neverRead: string[];
  otherResults: string[];
  tools: string[];
  writes: string;
  output: string;
  pasted: string[];
  notes: string[];
  gather: string[];
  prompt: string | null;
  humanNotes: string;
  reads: string[];
  eachRun: string;
  shell: boolean;
  writesTo: string[];
  gatherFiles: string[];
  mode: TaskMode;
  connectors: "on" | "none";
  deny: string[];
  schedule: string;
  listNote: string | null;
}

const join = (...parts: string[]): string => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function neverReads(patterns: string[], p: string): boolean {
  return patterns.some((pat) => {
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m === "*" ? "[^/]*" : ".*")) + "$", "i");
    return re.test(p) || (pat.startsWith("**/") && re.test("/" + p.replace(/^\/+/, "")));
  });
}
export function neverReadPatterns(env: Pick<ReachEnv, "vaultAbs" | "home" | "configDir" | "transcriptsFolder" | "transcriptNotes" | "neverRead">): string[] {
  const abs = (vp: string) => (vp ? join(env.vaultAbs, vp) : env.vaultAbs);
  const both = (p: string) => [p, `${p}/**`];
  return uniq([
    ...NEVER_READ_HOME.map((p) => join(env.home, p)),
    ...(env.configDir ? both(abs(env.configDir)) : []),
    ...NEVER_READ_ANYWHERE,
    ...(env.configDir ? [`**/${env.configDir}/**`] : []),
    ...(env.transcriptsFolder ? both(abs(env.transcriptsFolder)) : []),
    ...(env.transcriptNotes || []).map(abs),
    ...env.neverRead.flatMap((p) => both(p.replace(/\/+$/, ""))),
  ]).sort();
}

export type PlaceStat = { real: string; kind: "file" | "folder" | "other" } | { error: "missing" | "denied" | "failed"; message?: string };

export function resolvePlaces(t: ScheduledTask, env: Pick<ReachEnv, "vaultAbs" | "home" | "configDir" | "transcriptsFolder" | "transcriptNotes" | "neverRead"> & { vaultReal?: string; pathDirs?: string[] }, stat: (abs: string) => PlaceStat): void {
  t.writePlaces = [];
  if (t.writes.length) {
    const w: ScheduledTask = { ...t, outside: t.writes, places: [], problems: [], writes: [], notes: [] };
    resolvePlaces(w, env, stat);
    for (const p of w.problems) t.problems.push(p.replace(/^Its file-access names/, "Its writes names").replace("a run can read a folder outside the vault, not a single file", "it can change a folder, not a single file"));
    const low = (p: string) => p.toLowerCase().replace(/\/+$/, "");
    const home = low(env.home);
    const under = (p: string, root: string) => p === root || p.startsWith(root + "/");
    const holds = (p: string, x: string) => x === p || x.startsWith(p + "/");
    const bin = (env.pathDirs || []).map(low).filter(Boolean);
    const readPlaces = t.outside.map((o) => { const x = o.startsWith("~/") ? `${env.home}/${o.slice(2)}` : o; const st = stat(x); return low("real" in st ? st.real : x); });
    for (const pl of w.places) {
      const p = low(pl.path);
      const rel = under(p, home) ? p.slice(home.length + 1) : null;
      const why =
        rel != null && (rel === "library" || rel.startsWith("library/")) ? "which is in ~/Library, where apps and macOS keep what they run and load"
        : rel != null && rel.startsWith(".") ? "which is a hidden folder in your home folder, where tools keep their settings"
        : ["/applications", "/library", "/system", "/usr", "/bin", "/sbin", "/opt", "/etc", "/private/etc", "/var", "/private/var"].some((r) => under(p, r)) ? "which is one of the system's folders"
        : bin.some((b) => holds(p, b) || under(p, b)) ? "which is, or holds, a folder on your PATH, where a program it left could later run"
        : readPlaces.some((q) => holds(q, p) || holds(p, q)) ? "which overlaps a folder its file-access names: list it under writes only"
        : "";
      if (why) t.problems.push(`Its writes names "${pl.path}", ${why}.`);
      else t.writePlaces.push(pl);
    }
  }
  if (t.notes.length) {
    const neverLow = neverReadPatterns(env).map((x) => x.toLowerCase());
    const sameAs = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
    for (const n of t.notes) {
      const asWritten = join(env.vaultAbs, n), viaReal = join(env.vaultReal || env.vaultAbs, n);
      const say = (why: string) => t.problems.push(`Its reads names "${n}", ${why}`);
      const st = stat(asWritten);
      if ("error" in st) { say(st.error === "missing" ? "which isn't on this computer." : "which couldn't be checked."); continue; }
      if (!sameAs(st.real, asWritten) && !sameAs(st.real, viaReal)) { say("which is a link: name the note it leads to."); continue; }
      if (st.kind !== "file") { say("which isn't a note."); continue; }
      if (neverReads(neverLow, asWritten.toLowerCase())) say("which no run may read (the never-read list).");
    }
  }
  const neverFold = neverReadPatterns(env).map((x) => x.toLowerCase());
  for (const f of t.folders) {
    const asWritten = join(env.vaultAbs, f), viaReal = join(env.vaultReal || env.vaultAbs, f);
    const st = stat(asWritten);
    const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
    if (neverReads(neverFold, asWritten.toLowerCase()) || neverReads(neverFold, `${asWritten.toLowerCase()}/`)) t.problems.push(`Its reads names "${f}", which no run may read (the never-read list).`);
    else if ("error" in st) t.problems.push(`Its reads names "${f}", which ${st.error === "missing" ? "isn't on this computer." : "couldn't be checked."}`);
    else if (!same(st.real, asWritten) && !same(st.real, viaReal)) t.problems.push(`Its reads names "${f}", which is a link or sits under one: name the folder it leads to.`);
  }
  t.places = [];
  if (!t.outside.length) return;
  const never = neverReadPatterns(env).map((x) => x.toLowerCase());
  const blocked = (p: string) => neverReads(never, p.toLowerCase()) || neverReads(never, `${p.toLowerCase()}/`);
  const fold = (p: string) => { const out: string[] = []; for (const x of p.split("/")) { if (x && x !== ".") out.push(x); } return "/" + out.join("/"); };
  const home = fold(env.home), vault = fold(env.vaultAbs), vaultReal = fold(env.vaultReal || env.vaultAbs);
  const inside = (p: string, root: string) => { const a = p.toLowerCase(), b = root.toLowerCase(); return a === b || a.startsWith(b === "/" ? "/" : b + "/"); };
  for (const w of t.outside) {
    const asWritten = fold(w.startsWith("~/") ? `${home}/${w.slice(2)}` : w);
    const say = (why: string) => t.problems.push(`Its file-access names "${w}", ${why}`);
    if (blocked(asWritten)) { say("which no run may read (the never-read list)."); continue; }
    const st = stat(asWritten);
    if ("error" in st) {
      say(st.error === "missing" ? "which isn't on this computer." : st.error === "denied" ? "which Obsidian isn't allowed to open (macOS privacy settings, or its permissions)." : `which couldn't be checked${st.message ? `: ${st.message}` : "."}`);
      continue;
    }
    const real = fold(st.real);
    if (st.kind === "file") { say("which is a file: a run can read a folder outside the vault, not a single file. Name its folder, or print the file in a Gather first command."); continue; }
    if (st.kind === "other") { say("which isn't a folder."); continue; }
    if (real === "/" || real.toLowerCase() === home.toLowerCase()) { say(`which is ${real === "/" ? "the whole disk" : "the whole home folder"}: set file-access to disk if that's meant.`); continue; }
    if ([vault, vaultReal].some((v) => inside(real, v))) { say("which is in this vault: name it in reads, or use vault."); continue; }
    if ([vault, vaultReal].some((v) => inside(v, real))) { say("which holds this vault: use vault, and name what else it needs."); continue; }
    if (real.toLowerCase() === "/volumes" || /(^|\/)(backups\.backupdb|[^/]*\.(?:previous|interrupted|inprogress)|\.timemachine)(\/|$)/i.test(real)) { say(real.toLowerCase() === "/volumes" ? "which is every disk at once: name a folder on one." : "which is a Time Machine backup, holding copies of what no run may read."); continue; }
    if (blocked(real)) { say(`which leads to ${real}, which no run may read (the never-read list).`); continue; }
    if (/[*?[\]{}!\\]/.test(real)) { say(`which leads to ${real}, a path with a character Claude reads as a pattern.`); continue; }
    if (!t.places.some((pl) => pl.path === real)) t.places.push({ path: real, kind: "folder" });
  }
  t.places.sort((a, b) => a.path.localeCompare(b.path));
}

export function resolveReach(t: ScheduledTask, env: ReachEnv): ResolvedReach {
  const abs = (vp: string) => (vp ? join(env.vaultAbs, vp) : env.vaultAbs);
  const cwd = abs(t.folder);
  const project = t.projectFolder ?? t.folder;
  const read: string[] = [];
  if (t.files === "project" && project !== t.folder) read.push(abs(project));
  else if (t.files === "vault") read.push(env.vaultAbs);
  else if (t.files === "disk") read.push("/");
  for (const f of t.folders.map(abs)) read.push(f);
  for (const pl of t.places) read.push(pl.path);
  const neverRead = neverReadPatterns(env);
  const otherResults = otherResultsOf(t, env, read);
  const tools = ["Read", "Glob", "Grep", "Write"];
  for (const x of t.tools) if (!tools.includes(x)) tools.push(x);
  const sites = t.web.mode === "sites" ? [...t.web.sites].sort() : [];
  const rules = t.web.mode === "search" ? ["WebSearch", "WebFetch"] : sites.flatMap((s) => [`WebFetch(domain:${s})`, `WebFetch(domain:*.${s})`]);
  if (t.web.mode === "search") tools.push("WebSearch", "WebFetch");
  else if (sites.length) tools.push("WebFetch");
  if (t.shell) tools.push("Bash");
  const outputFolder = t.output ? parentOf(t.output) : join(t.folder, OUTPUTS_FOLDER);
  const online = t.web.mode !== "off";
  const notes = uniq(t.notes.map(abs)).filter((p) => !neverReads(neverRead, p));
  const named = (p: string) => !online || notes.includes(p);
  const pasted = uniq([
    ...(env.agent?.instructions && named(abs(env.agent.instructions)) ? [abs(env.agent.instructions)] : []),
    ...(online ? [] : env.overviews.map(abs)),
    ...notes,
  ]).filter((p) => !neverReads(neverRead, p));
  const listNote = t.web.listNote ? abs(t.web.listNote) : null;
  if (t.mode === "full") {
    return {
      backend: t.backend, model: t.model, agent: env.agent?.name ?? null,
      web: { search: t.web.mode === "search", sites, rules: [] },
      cwd: env.startAbs || env.vaultAbs, read: [], neverRead: uniq((env.userNeverRead ?? env.neverRead).flatMap((p) => { const b = p.replace(/\/+$/, ""); return [b, `${b}/**`]; })).sort(), otherResults: [], tools: [],
      writes: join(cwd, OUTPUTS_FOLDER, "<run>"), output: abs(outputFolder),
      pasted: [], notes: [], gather: [], prompt: t.prompt, humanNotes: t.humanNotes, reads: [...t.readsResolved], eachRun: t.eachRun,
      shell: false, writesTo: [], gatherFiles: [],
      mode: "full", connectors: t.connectors, deny: [...t.deny].sort(), schedule: t.scheduleText, listNote,
    };
  }
  return {
    backend: t.backend,
    model: t.model,
    agent: env.agent?.name ?? null,
    web: { search: t.web.mode === "search", sites, rules },
    cwd,
    read: uniq(read),
    neverRead,
    otherResults,
    tools,
    writes: join(cwd, OUTPUTS_FOLDER, "<run>"),
    output: abs(outputFolder),
    pasted,
    notes,
    gather: [...t.gather],
    prompt: t.prompt,
    humanNotes: t.humanNotes,
    reads: [],
    eachRun: t.eachRun,
    shell: t.shell,
    writesTo: t.shell ? t.writePlaces.map((p) => p.path) : [],
    gatherFiles: [...(env.gatherFiles || [])],
    mode: "headless", connectors: "none", deny: [], schedule: "", listNote,
  };
}

function otherResultsOf(t: ScheduledTask, env: ReachEnv, read: string[]): string[] {
  const abs = (vp: string) => (vp ? join(env.vaultAbs, vp) : env.vaultAbs);
  const under = (p: string, root: string) => root === "/" || p === root || p.startsWith(root + "/");
  const named = t.folders.map(abs);
  const out: string[] = [];
  for (const f of env.otherTasks || []) {
    if (f === t.folder) continue;
    const a = abs(f);
    if (!read.some((r) => under(a, r))) continue;
    if (named.some((n) => n === a || n.startsWith(a + "/"))) continue;
    out.push(join(a, OUTPUTS_FOLDER), `${join(a, OUTPUTS_FOLDER)}/**`, join(a, TASK_MEMORY_FILE));
  }
  return uniq(out).sort();
}

export function reachKey(r: ResolvedReach): string {
  return JSON.stringify([r.backend, r.model, r.agent, r.web.search, r.web.sites, r.web.rules, r.cwd, r.read, r.neverRead, r.tools, r.writes, r.output, r.pasted, r.gather, r.prompt, r.eachRun, ...(r.shell ? ["shell"] : []), ...(r.writesTo.length ? ["writes", ...r.writesTo] : []), ...(r.gatherFiles.length ? ["gather-files", ...r.gatherFiles] : []), ...(r.mode === "full" ? ["full", r.connectors, r.deny, r.schedule] : []), ...(r.listNote ? ["list-note", r.listNote] : []), ...(r.reads.length ? ["reads", ...r.reads] : []), ...(r.humanNotes ? ["human-notes", r.humanNotes] : [])]);
}
export function reachHash(key: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0").slice(-8);
}

export function gatherRelativeFiles(gather: string[], taskFolder?: string): string[] {
  const out: string[] = [];
  for (const raw of gather) {
    const cmd = withoutRedirectTargets(raw);
    const inTask = taskFolder != null && /^\s*cd\s+(["']?)\$(?:\{AM_TASK\}|AM_TASK\b)\1\s*(?:&&|;)/.test(cmd);
    const body = inTask ? cmd.replace(/^\s*cd\s+\S+\s*(?:&&|;)/, " ") : cmd;
    for (const m of body.matchAll(/"([^"]*)"|'([^']*)'|([^\s"';|&()<>]+)/g)) {
      let w = m[1] ?? m[2] ?? m[3] ?? "";
      if (!w || /[$`*?=]|:\/\//.test(w) || /^[-/~]/.test(w)) continue;
      w = w.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
      if (!w || !(w.includes("/") || /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|swift|applescript|scpt)$/i.test(w))) continue;
      const p = inVaultPath(inTask ? `${taskFolder}/${w}` : w);
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
function inVaultPath(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}
export function withoutRedirectTargets(cmd: string): string {
  let out = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { out += c; if (c === "\\" && q === '"' && i + 1 < cmd.length) out += cmd[++i]; else if (c === q) q = null; continue; }
    if (c === "\\" && i + 1 < cmd.length) { out += c + cmd[++i]; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c !== ">") { out += c; continue; }
    let k = i + 1;
    if (cmd[k] === ">" || cmd[k] === "|") k++;
    if (cmd[k] === "(") { out += cmd.slice(i, k); i = k - 1; continue; }
    while (cmd[k] === " " || cmd[k] === "\t") k++;
    if (cmd[k] === "(" || cmd[k] === "&") { out += cmd.slice(i, k); i = k - 1; continue; }
    let wq: string | null = null;
    while (k < cmd.length) {
      const d = cmd[k];
      if (wq) { if (d === wq) wq = null; k++; continue; }
      if (d === "'" || d === '"') { wq = d; k++; continue; }
      if (/[\s;|&()<>]/.test(d)) break;
      k++;
    }
    out += " ";
    i = k - 1;
  }
  return out;
}
export function gatherVaultFiles(gather: string[], taskFolder?: string): string[] {
  const out: string[] = [];
  const add = (name: string, rel: string) => {
    if (!rel) return;
    if (name === "AM_TASK" && taskFolder == null) return;
    const p = inVaultPath(name === "AM_TASK" ? `${taskFolder}/${rel}` : rel);
    if (p && !out.includes(p)) out.push(p);
  };
  const v = "\\$(?:\\{(AM_VAULT|AM_TASK)\\}|(AM_VAULT|AM_TASK)\\b)\\/";
  const re = new RegExp(`"${v}([^"]+)"|'${v}([^']+)'|${v}([^\\s"';|&)]+)`, "g");
  for (const raw of gather) {
    const cmd = withoutRedirectTargets(raw);
    for (const m of cmd.matchAll(re)) add(m[1] || m[2] || m[4] || m[5] || m[7] || m[8] || "", (m[3] || m[6] || m[9] || "").replace(/\/+$/, ""));
    for (const m of cmd.matchAll(/(["'])\$(?:\{(AM_VAULT|AM_TASK)\}|(AM_VAULT|AM_TASK)\b)\1\/(?:"([^"]+)"|'([^']+)'|([^\s"';|&)]+))/g)) add(m[2] || m[3] || "", (m[4] || m[5] || m[6] || "").replace(/\/+$/, ""));
  }
  return out;
}
