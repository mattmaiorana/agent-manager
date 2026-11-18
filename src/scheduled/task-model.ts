
import { GATHER_HEADING, HUMAN_NOTES_HEADING, OUTPUTS_FOLDER, PROMPT_HEADING, RUN_LOG_FILE, TASK_MEMORY_FILE, SCHEDULED_BACKENDS, SCHEDULED_TYPE, SESSION_DENY_NAME, TASK_PROPS } from "../constants/scheduled.js";
import type { TaskEachRun } from "../constants/scheduled.js";
import { isArchived as isArchivedPath } from "../util/paths.js";
import { VAULT_QUERY_NAMES } from "./vault-queries.js";
import { emptyContext, readsOf } from "../context/launch-context.js";
import type { ContextVault } from "../context/launch-context.js";
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
  web: { mode: "off" | "search" | "sites"; sites: string[]; listNote: string | null };
  connectors: "on" | "none";
  deny: string[];
  chrome: boolean;
  obsidianCli: string[];
  ownFolder: boolean;
  eachRun: TaskEachRun;
  onlyWhenNew: boolean;
  catchUp: boolean;
  output: string;
  followUp: "" | "ticket";
  tab: "keep" | "close";
  shell: boolean;
  scheduleText: string;
  rules: SchedParsed;
  prompt: string;
  humanNotes: string;
  readsResolved: string[];
  readsMissing: string[];
  headlessNote: boolean;
}

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
function switchOf(v: unknown): boolean | null {
  const b = boolOf(v);
  if (b != null) return b;
  const s = plain(v).toLowerCase();
  return s === "on" ? true : s === "off" ? false : null;
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
    web: { mode: "off", sites: [], listNote: null }, connectors: "on", deny: [], chrome: false, obsidianCli: [], ownFolder: false, eachRun: "new",
    onlyWhenNew: false, catchUp: true, output: "", followUp: "", tab: "keep", shell: true, scheduleText: "",
    rules: { error: "No schedule set" }, prompt: "", humanNotes: "", readsResolved: [], readsMissing: [], headlessNote: false,
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
  const removed = "Headless scheduled tasks were removed in this version.";
  const toFull = "Set mode to full to run it as a full Claude Code session, which reads and writes what any session can, with connectors and a shell unless set off, and delete file-access, tools, writes, and Gather first.";
  if (mode !== "full") problems.push(mode === "headless" || !mode ? `${removed} ${toFull}` : `Its mode "${mode}" isn't full: ${toFull.charAt(0).toLowerCase()}${toFull.slice(1)}`);

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
    t.readsMissing = [...rctx.missingReads];
    if (rctx.missingReads.length) problems.push(`Its reads name${rctx.missingReads.length === 1 ? "s" : ""} ${rctx.missingReads.join(", ")}, which ${rctx.missingReads.length === 1 ? "isn't" : "aren't"} in the vault.`);
  }
  const set = (k: keyof typeof TASK_PROPS) => { const v = get(k); return v != null && v !== ""; };
  const headlessOnly = [set("files") && "file-access", set("writes") && "writes", set("tools") && "tools"].filter(Boolean);
  t.headlessNote = mode !== "full" || headlessOnly.length > 0;
  if (headlessOnly.length) problems.push(`${removed} Delete ${headlessOnly.join(", ")}: ${headlessOnly.length > 1 ? "they" : "it"} applied only to headless runs, and a full session reads and writes as any session does.`);
  if (new RegExp(`^##[ \\t]+${GATHER_HEADING}[ \\t]*$`, "m").test((input.text || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""))) problems.push(`${removed} A full session doesn't use ## ${GATHER_HEADING}: move the commands into the prompt, and delete the section.`);

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

  {
    const raw = get("shell");
    const v = raw == null || raw === "" ? true : switchOf(raw);
    if (v == null) problems.push(`Its shell "${plain(raw)}" isn't true or false.`);
    t.shell = v !== false;
  }

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

  const connectors = plain(get("connectors")).toLowerCase();
  if (connectors === "none" || connectors === "off" || connectors === "false") t.connectors = "none";
  else if (!connectors || connectors === "on" || connectors === "true") t.connectors = "on";
  else problems.push(`Its connectors "${connectors}" isn't on or none.`);
  const BUILT_IN = ["Bash", "WebFetch", "WebSearch", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "Agent", "Skill", "TodoWrite"];
  for (const d of listOf(get("deny"))) {
    const w = d.trim();
    const name = BUILT_IN.find((x) => x.toLowerCase() === w.toLowerCase()) || w;
    if (!SESSION_DENY_NAME.test(name)) problems.push(`Its deny names "${d}", which isn't a tool's name, such as WebSearch or mcp__claude_ai_Gmail__send_message.`);
    else if (!t.deny.includes(name)) t.deny.push(name);
  }
  const sw = (k: keyof typeof TASK_PROPS): boolean | null => { const v = get(k); return v == null || v === "" ? null : switchOf(v); };
  const swSet = (k: keyof typeof TASK_PROPS) => { const v = get(k); return v != null && v !== ""; };
  for (const k of ["chrome", "ownFolder"] as const) if (swSet(k) && sw(k) == null) problems.push(`Its ${TASK_PROPS[k]} "${plain(get(k))}" isn't on or off.`);
  t.chrome = sw("chrome") === true;
  t.ownFolder = sw("ownFolder") === true;
  for (const q of listOf(get("obsidianCli"))) {
    const name = q.trim().toLowerCase();
    if (name === "off" || name === "none" || name === "false") continue;
    if (!VAULT_QUERY_NAMES.includes(name)) problems.push(`Its obsidian-cli names "${q}": it lists the questions the plugin asks Obsidian before each run, from ${VAULT_QUERY_NAMES.join(", ")}.`);
    else if (!t.obsidianCli.includes(name)) t.obsidianCli.push(name);
  }
  const shellOn = t.shell && !t.deny.includes("Bash");
  const sandboxed = t.web.mode !== "search";
  if (t.chrome && t.web.mode !== "search") problems.push(`Its chrome needs web: search: Claude in Chrome reaches any site, so it can't run with the web ${t.web.mode === "off" ? "off" : "held to a list of sites"}.`);
  if (t.ownFolder && shellOn && !sandboxed) problems.push("Its own-folder-only needs the web off or a list of sites, or no shell: with web search its shell isn't sandboxed and could write anywhere.");
  return t;
}

export interface ReachEnv {
  vaultAbs: string;
  agent: { name: string } | null;
  startAbs?: string;
  neverRead: string[];
}

export interface ResolvedReach {
  backend: string;
  model: string;
  agent: string | null;
  web: { search: boolean; sites: string[] };
  cwd: string;
  neverRead: string[];
  writes: string;
  output: string;
  prompt: string;
  humanNotes: string;
  reads: string[];
  eachRun: string;
  shell: boolean;
  connectors: "on" | "none";
  deny: string[];
  schedule: string;
  chrome: boolean;
  obsidianCli: string[];
  ownFolder: string;
  listNote: string | null;
  followUp: boolean;
}

const join = (...parts: string[]): string => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function neverReads(patterns: string[], p: string): boolean {
  return patterns.some((pat) => {
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m === "*" ? "[^/]*" : ".*")) + "$", "i");
    return re.test(p) || (pat.startsWith("**/") && re.test("/" + p.replace(/^\/+/, "")));
  });
}

export function resolveReach(t: ScheduledTask, env: ReachEnv): ResolvedReach {
  const abs = (vp: string) => (vp ? join(env.vaultAbs, vp) : env.vaultAbs);
  const cwd = abs(t.folder);
  const outputFolder = t.output ? parentOf(t.output) : join(t.folder, OUTPUTS_FOLDER);
  return {
    backend: t.backend, model: t.model, agent: env.agent?.name ?? null,
    web: { search: t.web.mode === "search", sites: t.web.mode === "sites" ? [...t.web.sites].sort() : [] },
    cwd: env.startAbs || env.vaultAbs,
    neverRead: uniq(env.neverRead.flatMap((p) => { const b = p.replace(/\/+$/, ""); return [b, `${b}/**`]; })).sort(),
    writes: join(cwd, OUTPUTS_FOLDER, "<run>"), output: abs(outputFolder),
    prompt: t.prompt, humanNotes: t.humanNotes, reads: [...t.readsResolved], eachRun: t.eachRun,
    shell: t.shell && !t.deny.includes("Bash"),
    connectors: t.connectors, deny: [...t.deny].sort(), schedule: t.scheduleText,
    chrome: t.chrome, obsidianCli: [...t.obsidianCli], ownFolder: t.ownFolder ? cwd : "",
    listNote: t.web.listNote ? abs(t.web.listNote) : null, followUp: t.followUp === "ticket",
  };
}

export function reachKey(r: ResolvedReach): string {
  return JSON.stringify([r.backend, r.model, r.agent, r.web.search, r.web.sites, r.cwd, r.neverRead, r.writes, r.output, r.prompt, r.eachRun, r.connectors, r.deny, r.schedule, ...(r.shell ? ["shell"] : []), ...(r.chrome ? ["chrome"] : []), ...(r.obsidianCli.length ? ["obsidian-cli", ...r.obsidianCli] : []), ...(r.ownFolder ? ["own-folder", r.ownFolder] : []), ...(r.listNote ? ["list-note", r.listNote] : []), ...(r.reads.length ? ["reads", ...r.reads] : []), ...(r.humanNotes ? ["human-notes", r.humanNotes] : []), ...(r.followUp ? ["follow-up"] : [])]);
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
