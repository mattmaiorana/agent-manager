// What a session gets from where it starts: whether it's a ticket, the overviews above
// it, and the repo they name. Everything that depends on where a session sits asks this
// one function (the opening now; the CLI flags and agents later), so a release that adds
// to it touches nothing else. Pure: the plugin hands it what it reads from the vault, so
// the Node tests run it on a folder tree in memory.

// What launchContext reads from the vault, by vault path.
export interface ContextVault {
  // Is there a note (a file) at this path?
  isNote(path: string): boolean;
  // A note's frontmatter, or null when it has none.
  frontmatter(path: string): Record<string, unknown> | null;
}

export interface ContextOptions {
  // The AGENTS.md folder, a vault path; "" for the vault's root. Overviews are read from
  // here down, and a note outside it gets none.
  startFolder: string;
  useOverviews: boolean;
  useTickets: boolean;
  // An overview's file name ("Overview.md" by default).
  overviewName: string;
  // The ticket template's path, never itself a ticket; "" for none.
  templatePath: string;
  // A `repo:` value as an absolute path (a leading ~ is the home folder), or null.
  resolvePath(value: string): string | null;
  // The agents with a home folder, by id, each home a vault path ("" for the root), in
  // settings order. The deepest home holding the session's note or folder gives its
  // agent; of two with the same home, the first.
  homes?: { id: string; home: string }[];
}

export interface LaunchContext {
  // The ticket's vault path, when the session starts from one.
  ticket: string | null;
  // Every overview from the AGENTS.md folder down to the session's folder, broadest
  // first, by vault path.
  overviews: string[];
  // The repo of the nearest overview that names one, as an absolute path.
  repo: string | null;
  // The agent whose home folder holds the session's note or folder (the deepest, when
  // homes nest), by id, or null. Only where the session sits: an agent recorded on the
  // session, or picked at launch, wins over it (plugin/agents.ts, launchAgentId).
  agent: string | null;
}

// Where a session starts: a note, or a folder.
export interface LaunchFrom {
  notePath?: string | null;
  folderPath?: string | null;
}

const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// Is `p` the folder `dir` or inside it? "" is the vault's root, which holds everything.
const within = (p: string, dir: string): boolean => !dir || p === dir || p.startsWith(dir + "/");

// Is the note at `path` a ticket? `type: ticket`, and not the template.
export function isTicket(path: string, vault: ContextVault, opts: Pick<ContextOptions, "useTickets" | "templatePath">): boolean {
  if (!opts.useTickets || !path || path === opts.templatePath) return false;
  const type = vault.frontmatter(path)?.type;
  return typeof type === "string" && type.trim().toLowerCase() === "ticket";
}

// The folders from `top` down to `bottom`, broadest first; empty when `bottom` isn't in `top`.
function folderChain(top: string, bottom: string): string[] {
  if (!within(bottom, top)) return [];
  const out: string[] = [];
  for (let dir = bottom; ; dir = parentOf(dir)) {
    out.unshift(dir);
    if (dir === top || !dir) break;
  }
  return out;
}

// The agent whose home holds `folder`: the deepest home, by id; null for none.
export function homeAgent(folder: string, homes: { id: string; home: string }[]): string | null {
  let best: { id: string; home: string } | null = null;
  for (const h of homes) {
    if (!h.id || !within(folder, h.home)) continue;
    if (!best || h.home.length > best.home.length) best = h;
  }
  return best ? best.id : null;
}

export function launchContext(from: LaunchFrom, vault: ContextVault, opts: ContextOptions): LaunchContext {
  const notePath = from.notePath || null;
  const folder = notePath ? parentOf(notePath) : (from.folderPath ?? null);
  const ctx: LaunchContext = { ticket: null, overviews: [], repo: null, agent: null };
  if (notePath && isTicket(notePath, vault, opts)) ctx.ticket = notePath;
  if (folder !== null) ctx.agent = homeAgent(folder, opts.homes || []);
  if (folder === null || !opts.useOverviews) return ctx;
  const name = opts.overviewName;
  for (const dir of folderChain(opts.startFolder, folder)) {
    const p = dir ? `${dir}/${name}` : name;
    if (vault.isNote(p)) ctx.overviews.push(p);
  }
  // The nearest overview that names a repo.
  for (const p of [...ctx.overviews].reverse()) {
    const repo = vault.frontmatter(p)?.repo;
    const abs = typeof repo === "string" && repo.trim() ? opts.resolvePath(repo.trim()) : null;
    if (abs) { ctx.repo = abs; break; }
  }
  return ctx;
}

// The opening, from its parts: the agent part when the session has an agent (`agent`, its
// name and its instructions note's absolute path, since which agent a session gets isn't
// only where it sits), the overviews part when there are overviews, the repo part when
// there's a repo, then the kind's own template, each as one line with its placeholders
// filled in ({{overviews}} is the overviews' absolute paths, quoted). An empty part is
// left out; all empty is "".
export type OpeningKind = "plain" | "daily" | "note" | "folder" | "ticket";
export type OpeningPartKey = OpeningKind | "agent" | "overviews" | "repo";
export function composeOpening(template: (key: OpeningPartKey) => string, ctx: LaunchContext, kind: OpeningKind, vars: Record<string, string>, absolute: (vaultPath: string) => string, agent: { name: string; instructions: string } | null = null): string {
  const all: Record<string, string> = { ...vars, overviews: ctx.overviews.map((p) => `"${absolute(p)}"`).join(", "), repo: ctx.repo || "", profile: agent?.name || "", instructions: agent?.instructions || "" };
  const fill = (key: OpeningPartKey) => template(key)
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .replace(/\{\{(\w+)\}\}/g, (whole, k: string) => (k in all ? all[k] : whole));
  const parts: string[] = [];
  if (agent) parts.push(fill("agent"));
  if (ctx.overviews.length) parts.push(fill("overviews"));
  if (ctx.repo) parts.push(fill("repo"));
  parts.push(fill(kind));
  return parts.filter(Boolean).join(" ");
}
