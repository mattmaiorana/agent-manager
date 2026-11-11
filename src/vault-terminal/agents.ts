
import { basename } from "path";
import { splitCommand } from "./finder";
import { prepareClaude } from "./claude";

export interface AgentProfile {
  id: string;
  name: string;
  command: string;
  icons: string[];
  reportsState: boolean;
  agentKeys: boolean;
  undoKey: boolean;
  prepare?: (words: string[], launch: LaunchContext) => void;
}

export interface LaunchContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  pictures: boolean;
}

export const AGENTS: readonly AgentProfile[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    icons: ["bot"],
    reportsState: true,
    agentKeys: true,
    undoKey: true,
    prepare: (words, { env, cwd, pictures }) => prepareClaude(words, env, cwd, { pictures }),
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    icons: ["code-xml", "code-2", "code", "bot"],
    reportsState: false,
    agentKeys: true,
    undoKey: false,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    command: "agy",
    icons: ["orbit", "sparkles", "bot"],
    reportsState: false,
    agentKeys: true,
    undoKey: true,
  },
];

export function prepareAgent(kind: string, program: string, words: string[], ctx: LaunchContext, plain: boolean): string[] {
  const before = { words: [...words], env: { ...ctx.env } };
  if (!plain) agentFor(kind, program)?.prepare?.(words, ctx);
  const added = [
    ...words.filter((w, k) => w.startsWith("--") && !before.words.includes(w) && k > 0),
    ...Object.keys(ctx.env).filter((k) => before.env[k] === undefined),
  ];
  return [...new Set(added)];
}

export function agentById(id: string): AgentProfile | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

export function agentForProgram(path: string): AgentProfile | null {
  const name = basename(path);
  return AGENTS.find((a) => basename(splitCommand(a.command)[0] ?? "") === name) ?? null;
}

export function agentFor(kind: string, programPath: string): AgentProfile | null {
  const opened = agentById(kind);
  if (!opened) return null;
  const named = agentForProgram(programPath);
  return named && named !== opened ? named : opened;
}
