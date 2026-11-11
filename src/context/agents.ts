
export interface AgentDef {
  id: string;
  name: string;
  instructions: string;
  home: string | null;
  dailyName: string;
  enabled: boolean;
}

export const DEFAULT_AGENT_DAILY_NAME = "Daily Chat - {{profile}} - {{date}}";

export function readAgents(raw: unknown): AgentDef[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentDef[] = [];
  const seen = new Set<string>();
  for (const e of raw as unknown[]) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!id || !name || seen.has(id) || /[\\/]/.test(name) || name.startsWith(".")) continue;
    seen.add(id);
    const inside = (v: unknown): string => (typeof v === "string" && !v.split(/[\\/]/).includes("..") ? v : "");
    out.push({
      id,
      name,
      instructions: inside(r.instructions).trim(),
      home: typeof r.home === "string" && inside(r.home) === r.home ? r.home : null,
      dailyName: typeof r.dailyName === "string" ? r.dailyName : "",
      enabled: r.enabled !== false,
    });
  }
  return out;
}

export function agentNameProblem(name: string, others: string[]): string | null {
  const n = name.trim();
  if (!n) return "An agent profile needs a name.";
  if (/[\\/:*?"<>|#^[\]]/.test(n)) return "A name can't have any of these: \\ / : * ? \" < > | # ^ [ ]";
  if (n.startsWith(".")) return "A name can't start with a dot.";
  if (others.some((o) => o.trim().toLowerCase() === n.toLowerCase())) return `There's already an agent profile named “${n}”.`;
  return null;
}

export function parseHome(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v === "/") return "";
  return v.replace(/^\/+|\/+$/g, "");
}

export function agentSlug(agent: Pick<AgentDef, "id" | "name">): string {
  const s = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || `agent-${agent.id.slice(0, 8)}`;
}

export function agentPrompt(name: string, instructionsPath: string): string {
  return instructionsPath
    ? `You are the ${name} agent. Your instructions are in the note at "${instructionsPath}". Read it in full before anything else, and again whenever you lose track of it (after a compaction, say), and operate as it says.`
    : `You are the ${name} agent.`;
}

export function agentArgs(backend: string, agent: (Pick<AgentDef, "id" | "name"> & { instructionsPath: string }) | null, { resume, slug: recorded, context = "" }: { resume: boolean; slug?: string | null; context?: string }): string[] {
  const prompt = agent ? agentPrompt(agent.name, agent.instructionsPath) : "";
  if (backend === "claude") {
    const out: string[] = [];
    if (agent) {
      const slug = recorded || agentSlug(agent);
      out.push("--agents", JSON.stringify({ [slug]: { description: `The ${agent.name} agent`, prompt } }), "--agent", slug);
    }
    if (context) out.push("--append-system-prompt", context);
    return out;
  }
  const text = [prompt, context].filter(Boolean).join("\n\n");
  if (backend === "codex" && !resume && text) return ["-c", `developer_instructions=${JSON.stringify(text)}`];
  return [];
}

export function listedAgent(recorded: string | null | undefined, known: Set<string>, defaultId: string | null): string {
  return recorded && known.has(recorded) ? recorded : (defaultId || "");
}
export function shownUnder(recorded: string | null | undefined, switched: string | null, known: Set<string>, defaultId: string | null): boolean {
  if (switched === null) return true;
  return listedAgent(recorded, known, defaultId) === switched;
}
