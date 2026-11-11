
export interface ContextVault {
  isNote(path: string): boolean;
  frontmatter(path: string): Record<string, unknown> | null;
  resolve?(link: string, from: string, asLink?: boolean): { path: string; folder: boolean } | null;
}

export interface ContextOptions {
  startFolder: string;
  useOverviews: boolean;
  useTickets: boolean;
  overviewName: string;
  templatePath: string;
  resolvePath(value: string): string | null;
  homes?: { id: string; home: string }[];
  isTask?(path: string): boolean;
}

export interface LaunchContext {
  ticket: string | null;
  task: string | null;
  overviews: string[];
  repo: string | null;
  agent: string | null;
  reads: { path: string; folder: boolean }[];
  missingReads: string[];
}

export function emptyContext(): LaunchContext {
  return { ticket: null, task: null, overviews: [], repo: null, agent: null, reads: [], missingReads: [] };
}

export interface LaunchFrom {
  notePath?: string | null;
  folderPath?: string | null;
}

const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const within = (p: string, dir: string): boolean => !dir || p === dir || p.startsWith(dir + "/");

export function isTicket(path: string, vault: ContextVault, opts: Pick<ContextOptions, "useTickets" | "templatePath">): boolean {
  if (!opts.useTickets || !path || path === opts.templatePath) return false;
  const type = vault.frontmatter(path)?.type;
  return typeof type === "string" && type.trim().toLowerCase() === "ticket";
}

function folderChain(top: string, bottom: string): string[] {
  if (!within(bottom, top)) return [];
  const out: string[] = [];
  for (let dir = bottom; ; dir = parentOf(dir)) {
    out.unshift(dir);
    if (dir === top || !dir) break;
  }
  return out;
}

export function homeAgent(folder: string, homes: { id: string; home: string }[]): string | null {
  let best: { id: string; home: string } | null = null;
  for (const h of homes) {
    if (!h.id || !within(folder, h.home)) continue;
    if (!best || h.home.length > best.home.length) best = h;
  }
  return best ? best.id : null;
}

export function readsOf(ticket: string, vault: ContextVault, ctx: LaunchContext): void {
  const raw = vault.frontmatter(ticket)?.reads;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  for (const e of list) {
    let v: unknown = e, depth = 0;
    while (Array.isArray(v) && v.length === 1) { v = v[0]; depth++; }
    if (typeof v !== "string") { if (v != null) ctx.missingReads.push(JSON.stringify(e)); continue; }
    if (!v.trim()) continue;
    const text = depth ? `[[${v.trim()}]]` : v.trim();
    const m = text.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
    const link = (m ? m[1] : text).trim().replace(/^\/+|\/+$/g, "");
    const hit = link && vault.resolve ? vault.resolve(link, ticket, !!m) : null;
    if (!hit) { ctx.missingReads.push(text); continue; }
    if (!ctx.reads.some((r) => r.path === hit.path)) ctx.reads.push(hit);
  }
}

export function launchContext(from: LaunchFrom, vault: ContextVault, opts: ContextOptions): LaunchContext {
  const notePath = from.notePath || null;
  const folder = notePath ? parentOf(notePath) : (from.folderPath ?? null);
  const ctx = emptyContext();
  if (notePath && isTicket(notePath, vault, opts)) ctx.ticket = notePath;
  else if (notePath && opts.isTask?.(notePath)) ctx.task = notePath;
  if (folder !== null) ctx.agent = homeAgent(folder, opts.homes || []);
  if (ctx.ticket || ctx.task) readsOf((ctx.ticket || ctx.task) as string, vault, ctx);
  if (folder === null || !opts.useOverviews) return ctx;
  const name = opts.overviewName;
  for (const dir of folderChain(opts.startFolder, folder)) {
    const p = dir ? `${dir}/${name}` : name;
    if (vault.isNote(p)) ctx.overviews.push(p);
  }
  for (const p of [...ctx.overviews].reverse()) {
    const repo = vault.frontmatter(p)?.repo;
    const abs = typeof repo === "string" && repo.trim() ? opts.resolvePath(repo.trim()) : null;
    if (abs) { ctx.repo = abs; break; }
  }
  return ctx;
}

export type OpeningKind = "plain" | "daily" | "note" | "folder" | "ticket" | "followUp" | "task";
export type OpeningPartKey = OpeningKind | "agent" | "overviews" | "repo";
export function composeOpening(template: (key: OpeningPartKey) => string, ctx: LaunchContext, kind: OpeningKind, vars: Record<string, string>, absolute: (vaultPath: string) => string, agent: { name: string; instructions: string } | null = null): string {
  const all: Record<string, string> = { ...vars, overviews: ctx.overviews.map((p) => `"${absolute(p)}"`).join(", "), repo: ctx.repo || "", profile: agent?.name || "", instructions: agent?.instructions || "" };
  const fill = (key: OpeningPartKey) => template(key)
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .replace(/\{\{(\w+)\}\}/g, (whole, k: string) => (k in all ? all[k].replace(/\s*\n\s*/g, " ") : whole));
  const parts: string[] = [];
  if (agent) parts.push(fill("agent"));
  if (ctx.overviews.length) parts.push(fill("overviews"));
  const own = fill(kind);
  if (own) parts.push(readsSentence(ctx.reads, absolute));
  if (ctx.repo) parts.push(fill("repo"));
  parts.push(own);
  return parts.filter(Boolean).join(" ");
}

export function readsSentence(reads: LaunchContext["reads"], absolute: (vaultPath: string) => string): string {
  const q = (r: { path: string }) => `"${absolute(r.path).replace(/\s*\n\s*/g, " ")}"`;
  const notes = reads.filter((r) => !r.folder).map(q), folders = reads.filter((r) => r.folder).map(q);
  return [
    notes.length ? `Also read ${notes.join(", ")}.` : "",
    folders.length ? `Also look in the ${folders.length === 1 ? "folder" : "folders"} ${folders.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

export function contextPrompt(ctx: LaunchContext, from: { kind: "ticket" | "note" | "folder" | "task"; path: string } | null, on: (key: OpeningPartKey) => boolean, absolute: (vaultPath: string) => string, run = false): string {
  if (!from) return "";
  const q = (p: string) => `"${absolute(p).replace(/\s*\n\s*/g, " ")}"`;
  const own = run || on(from.kind);
  const out: string[] = [];
  if (own) out.push(`This session was started from the ${from.kind === "task" ? "scheduled task" : from.kind} at ${q(from.path)}.`);
  if (ctx.overviews.length && on("overviews")) out.push(`Its project's ${ctx.overviews.length === 1 ? "overview is" : "overviews, broadest first, are"} ${ctx.overviews.map(q).join(", ")}.`);
  if (own) out.push(readsSentence(ctx.reads, absolute));
  if (ctx.repo && on("repo")) out.push(`Its repo is at "${ctx.repo.replace(/\s*\n\s*/g, " ")}".`);
  const said = out.filter(Boolean);
  if (!said.length) return "";
  const named = said.length > (own ? 1 : 0);
  return named ? `${said.join(" ")} Read them again whenever you lose track of them (after a compaction, say).` : said.join(" ");
}
