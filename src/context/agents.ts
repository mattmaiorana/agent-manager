// Agents: what one is, how its name is checked, and how each CLI is given it. Pure, so
// the Node tests run it; the plugin's side is plugin/agents.ts.

// An agent, as settings keep it. `id` is the plugin's own and never changes, so a rename
// doesn't strand the sessions recorded under it; `name` is what's shown, the transcript
// subfolder's name, and (as a slug) Claude's agent name. `home` is a vault path, "" for
// the vault's root, or null for none. `dailyName` is the Daily Chat name's template.
// `enabled`: an agent turned off keeps its settings but is left out of everything new (the
// switch, homes, the Default agent), and its sessions are listed as if they had none.
export interface AgentDef {
  id: string;
  name: string;
  instructions: string;
  home: string | null;
  dailyName: string;
  enabled: boolean;
}

// A new agent's Daily Chat name, by default.
export const DEFAULT_AGENT_DAILY_NAME = "{{profile}} Daily Chat - {{date}}";

// The agents in saved data, each checked: an entry without an id or a name is skipped, and
// so is a second one with an id already seen.
export function readAgents(raw: unknown): AgentDef[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentDef[] = [];
  const seen = new Set<string>();
  for (const e of raw as unknown[]) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      instructions: typeof r.instructions === "string" ? r.instructions.trim() : "",
      home: typeof r.home === "string" ? r.home : null,
      dailyName: typeof r.dailyName === "string" ? r.dailyName : "",
      enabled: r.enabled !== false,
    });
  }
  return out;
}

// What's wrong with a name for an agent, or null: it names a folder and has to tell the
// agents apart, so it can't be empty, can't hold a path character or start with a dot,
// and can't match another agent's ignoring case.
export function agentNameProblem(name: string, others: string[]): string | null {
  const n = name.trim();
  if (!n) return "An agent profile needs a name.";
  if (/[\\/:*?"<>|#^[\]]/.test(n)) return "A name can't have any of these: \\ / : * ? \" < > | # ^ [ ]";
  if (n.startsWith(".")) return "A name can't start with a dot.";
  if (others.some((o) => o.trim().toLowerCase() === n.toLowerCase())) return `There's already an agent profile named “${n}”.`;
  return null;
}

// A home folder as written in settings: empty is no home, "/" is the vault's root, and
// anything else is a vault path without slashes at its ends.
export function parseHome(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v === "/") return "";
  return v.replace(/^\/+|\/+$/g, "");
}

// The name Claude knows the agent by: lowercase letters, digits, and hyphens.
export function agentSlug(agent: Pick<AgentDef, "id" | "name">): string {
  const s = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || `agent-${agent.id.slice(0, 8)}`;
}

// What Claude and Codex are told the agent is: who it is and which note to read. A
// pointer, not the note's text, so the note stays the one place it's written.
export function agentPrompt(name: string, instructionsPath: string): string {
  return instructionsPath
    ? `You are the ${name} agent. Your instructions are in the note at "${instructionsPath}". Read it in full before anything else, and again whenever you lose track of it (after a compaction, say), and operate as it says.`
    : `You are the ${name} agent.`;
}

// The flags that give a CLI its agent, for a launch, a resume, or a fork (`resume` covers
// both). Both Claude and Codex keep the agent a conversation launched as through every
// resume and fork. Claude is given it on every start anyway, since a resume without it
// warns that the agent is "no longer available"; Codex ignores its instructions given
// again, so it's given them at launch only.
// Antigravity's --agent takes only agents in its own files: it gets the opening instead.
// Tested 2026-10-22 (REFERENCE.md, "Agents and the CLIs").
// `slug`, for a Claude resume or fork: the agent name the conversation recorded
// (`agentSetting`), which a rename since mustn't change, or Claude reports the agent gone.
export function agentArgs(backend: string, agent: (Pick<AgentDef, "id" | "name"> & { instructionsPath: string }) | null, { resume, slug: recorded }: { resume: boolean; slug?: string | null }): string[] {
  if (!agent) return [];
  const prompt = agentPrompt(agent.name, agent.instructionsPath);
  if (backend === "claude") {
    const slug = recorded || agentSlug(agent);
    return ["--agents", JSON.stringify({ [slug]: { description: `The ${agent.name} agent`, prompt } }), "--agent", slug];
  }
  // A TOML string: JSON's escaping is TOML's for a basic string.
  if (backend === "codex" && !resume) return ["-c", `developer_instructions=${JSON.stringify(prompt)}`];
  return [];
}

// The agent a session is listed under: its own, or for one with none (or whose agent is
// gone, or that the plugin didn't start), the Default agent; "" for No agent.
export function listedAgent(recorded: string | null | undefined, known: Set<string>, defaultId: string | null): string {
  return recorded && known.has(recorded) ? recorded : (defaultId || "");
}
// Is a session listed under the switch's pick? `switched` is an agent's id, "" for No
// agent, or null when there are no agents, which lists everything.
export function shownUnder(recorded: string | null | undefined, switched: string | null, known: Set<string>, defaultId: string | null): boolean {
  if (switched === null) return true;
  return listedAgent(recorded, known, defaultId) === switched;
}
