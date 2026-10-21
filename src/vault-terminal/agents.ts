// The agent CLIs the terminal knows by name, and what each needs beyond the
// defaults. No Obsidian or xterm code here, so test/harness.ts can check it.
//
// Every program, an agent not yet known included, gets ordinary terminal
// behavior that's safe for anything:
// Cmd+C copies the terminal's own selection, Option-drag selects even when a
// program has the mouse, Shift+Enter is Esc then Return, Cmd+click opens a
// link once, a bell marks an unwatched tab, and the tab shows running, then
// exited. A profile below adds what one agent was shown, by testing (the
// self-test's "agent: <command>" battery), to need on top. Nothing an agent
// asks the terminal for is taken to mean more than it says: an editor asks
// for the same kitty keyboard flags Codex does.

import { basename } from "path";
import { splitCommand } from "./finder";
import { prepareClaude } from "./claude";

export interface AgentProfile {
  /** The terminal kind, saved in the workspace, and the command ids ("open-<id>"). */
  id: string;
  /** For people: "Open Claude", the tab's name before the program names it. */
  name: string;
  /** The default command, with any arguments. */
  command: string;
  /** Tab icons, first choice first (Lucide names vary between Obsidian versions). */
  icons: string[];
  /**
   * The program says what it's doing in a form the terminal reads
   * (status.ts), so its tab starts at unknown rather than running.
   */
  reportsState: boolean;
  /**
   * It copies its own selection on Super+C (kitty encoding) and attaches a
   * clipboard image on Ctrl+V, so Cmd+C (with the mouse captured) and an
   * image-only Cmd+V go on as those. Only for an agent shown to do both.
   */
  agentKeys: boolean;
  /** It reads Ctrl+_ as undoing the last edit in its prompt, so Cmd+Z sends it. */
  undoKey: boolean;
  /** Adds what its command line and environment need from the terminal, in place. */
  prepare?: (words: string[], launch: LaunchContext) => void;
}

/** What a profile's prepare can read and change besides the command line. */
export interface LaunchContext {
  /** The program's environment, changed in place. */
  env: NodeJS.ProcessEnv;
  /** The folder it starts in. */
  cwd: string;
  /** "Show pictures". */
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
    // Claude Code documents Ctrl+_ as "Undo last input edit".
    undoKey: true,
    // Its notification channel and steady scrolling, for this session only (claude.ts).
    prepare: (words, { env, cwd, pictures }) => prepareClaude(words, env, cwd, { pictures }),
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    icons: ["code-xml", "code-2", "code", "bot"],
    reportsState: false,
    agentKeys: true,
    // Ctrl+_ did nothing in its prompt, so Cmd+Z isn't sent.
    undoKey: false,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    command: "agy",
    icons: ["orbit", "sparkles", "bot"],
    reportsState: false,
    agentKeys: true,
    // Ctrl+_ undid the last word typed in its prompt.
    undoKey: true,
  },
];

/**
 * An agent's command line and environment with the terminal's additions
 * (its profile's prepare), in place, unless plain; returns what was added,
 * by name, for the line a retry without them shows. Words already in
 * the command count as the user's or the host's, never as additions: a
 * host's own arguments (a session id, a resume) are never dropped by the
 * retry, which would start a fresh session where the host meant its own.
 */
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

/** The profile whose default program has this file name, or null. */
export function agentForProgram(path: string): AgentProfile | null {
  const name = basename(path);
  return AGENTS.find((a) => basename(splitCommand(a.command)[0] ?? "") === name) ?? null;
}

/**
 * The profile for what a terminal runs: the agent it was opened as, since
 * its command may start it any way (npx, env, a wrapper, a versioned name);
 * unless the program is plainly another known agent (Codex set as Claude's
 * command), which then gets its own profile, not the one it was opened as.
 */
export function agentFor(kind: string, programPath: string): AgentProfile | null {
  const opened = agentById(kind);
  if (!opened) return null;
  const named = agentForProgram(programPath);
  return named && named !== opened ? named : opened;
}
