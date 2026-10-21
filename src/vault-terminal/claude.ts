// What a claude session the terminal starts is passed, beyond its command:
// all through claude's documented per-session routes (--settings, which
// overrides the user's settings files for that session only, and its
// environment), never by changing the user's files, and never where the
// user has set the same thing. No Obsidian or xterm code here, so
// test/harness.ts can check it.

import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { expandPath, inlineSettings, withSessionSettings } from "./finder";
import { HOOK_ID } from "./status";

export interface ClaudeOptions {
  /** "Show pictures" is on: claude is told the terminal draws kitty placeholder pictures. */
  pictures?: boolean;
}

const SCROLL_SPEED = "CLAUDE_CODE_SCROLL_SPEED";
/** The scroll speed claude is given: one line a report, whatever the timing (prepareClaude). */
export const CLAUDE_SCROLL_SPEED = "0.25";
const ACCELERATION = "wheelScrollAccelerationEnabled";
const MANAGED = "/Library/Application Support/ClaudeCode";

/**
 * Adds to a claude command line and its environment, in place:
 * - the kitty notification channel, so its tab can show waiting and finished;
 * - hooks that report its state at once (sessionHooks);
 * - scroll speed 0.25 and no wheel acceleration, so one
 *   report (one cell height of wheel travel, wheel.ts) moves one line, as in
 *   a shell. Only when the user has set neither anywhere claude reads them:
 *   the two are tuned together, so the user's own setting of either leaves
 *   both to them. Why 0.25 and not 1: in a terminal that answers XTVERSION as
 *   xterm.js, claude scrolls floor(speed × 3) lines for a report more than
 *   40 ms after the last and floor(speed) for any other, never under 1, and
 *   ignores the acceleration setting; at speed 1 a slowing scroll jumps 3
 *   rows a report, and at 0.25 every report is one line. Check it after a
 *   claude update: one wheel report should move claude's view one line.
 */
export function prepareClaude(words: string[], env: NodeJS.ProcessEnv, cwd: string, options: ClaudeOptions): void {
  const extra: Record<string, unknown> = { preferredNotifChannel: "kitty", hooks: sessionHooks() };
  if (!userScrollSetting(words, env, cwd) && !settingsFileFlag(words)) {
    extra[ACCELERATION] = false;
    env[SCROLL_SPEED] = CLAUDE_SCROLL_SPEED;
  }
  // What this terminal supports that claude can't detect (it recognizes
  // terminals by name, and the terminal doesn't pretend to be another).
  // Set to anything, empty included, is the user's choice: an empty value turns
  // the feature off in claude.
  const supported = options.pictures ? { ...SUPPORTED, [PICTURES]: "1" } : SUPPORTED;
  for (const [name, value] of Object.entries(supported)) {
    if (env[name] === undefined && !userSetting(words, env, cwd, { vars: [name] })) env[name] = value;
  }
  withSessionSettings(words, extra);
}

/** Which hook events report which state. */
const HOOK_EVENTS: [string, string][] = [
  ["UserPromptSubmit", "working"],
  // After a tool, approved or not needing approval: working again.
  ["PostToolUse", "working"],
  ["PostToolUseFailure", "working"],
  ["PermissionRequest", "waiting"],
  ["Stop", "finished"],
  ["StopFailure", "error"],
];

/**
 * claude's hooks for this session, which run alongside the user's own: each
 * prints a fixed answer whose terminalSequence (Claude Code's documented way
 * for a hook to write to the terminal) is an OSC 99 with the terminal's id
 * and the state, so it arrives in order with claude's output. printf, not
 * echo: sh's echo may read the backslashes itself.
 */
export function sessionHooks(): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, state] of HOOK_EVENTS) {
    const command = `printf '%s\\n' '{"terminalSequence":"\\u001b]99;i=${HOOK_ID};${state}\\u0007"}'`;
    hooks[event] = [{ hooks: [{ type: "command", command }] }];
  }
  return hooks;
}

/**
 * claude's documented variables for "the terminal supports this but isn't
 * auto-detected", for what xterm.js 6.0.0 does: synchronized output (mode
 * 2026) and strikethrough (SGR 9). Without them claude
 * showed ~~text~~ here. FORCE_HYPERLINK is left out on purpose: the commands
 * claude runs inherit it, and some then print
 * OSC 8 escapes into output the model reads and may copy into files.
 */
const SUPPORTED: Record<string, string> = {
  CLAUDE_CODE_FORCE_SYNC_OUTPUT: "1",
  CLAUDE_CODE_FORCE_STRIKETHROUGH: "1",
};

/**
 * claude's documented variable for a terminal that draws kitty graphics
 * protocol pictures with Unicode placeholders but isn't detected: its
 * startup asks nothing this terminal could answer, so pictures need it.
 * Off with "Show pictures", or where the user has set it, it isn't added.
 */
export const PICTURES = "CLAUDE_CODE_FORCE_TERMINAL_IMAGES";

/** Whether the command points --settings at a file, which can't be merged with. */
function settingsFileFlag(words: string[]): boolean {
  const i = words.findIndex((w) => w === "--settings" || w.startsWith("--settings="));
  if (i < 0) return false;
  return !inlineSettings(words[i] === "--settings" ? words[i + 1] ?? "" : words[i].slice("--settings=".length));
}

/** Environment variables and settings keys to look for. */
interface Wanted {
  vars: string[];
  keys?: string[];
}

/** Whether a settings object sets one of the keys, or one of the variables in its env block. */
function setsAny(settings: unknown, wanted: Wanted): boolean {
  if (!settings || typeof settings !== "object") return false;
  const s = settings as Record<string, unknown>;
  const env = s.env as Record<string, unknown> | undefined;
  return (wanted.keys ?? []).some((k) => k in s) || (!!env && typeof env === "object" && wanted.vars.some((v) => v in env));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Where the user has set claude's scroll speed or wheel acceleration, or
 * null: the environment, the command (its own --settings, inline or a file,
 * or a VAR=value word before the program), or a settings file claude reads
 * (managed, the user's, which /scroll-speed saves to, and the project's).
 */
export function userScrollSetting(words: string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  return userSetting(words, env, cwd, { vars: [SCROLL_SPEED], keys: [ACCELERATION] });
}

/** Where the user has set any of these variables or settings keys for claude, or null (see userScrollSetting). */
export function userSetting(words: string[], env: NodeJS.ProcessEnv, cwd: string, wanted: Wanted): string | null {
  if (wanted.vars.some((v) => env[v] !== undefined && env[v] !== "")) return "environment";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (wanted.vars.some((v) => w.startsWith(`${v}=`))) return "command";
    if (w === "--settings" || w.startsWith("--settings=")) {
      const value = w === "--settings" ? words[i + 1] ?? "" : w.slice("--settings=".length);
      const settings = inlineSettings(value) ?? readJson(expandPath(value.startsWith("~") || value.startsWith("/") ? value : join(cwd, value)));
      if (setsAny(settings, wanted)) return "command";
    }
  }
  // A CLAUDE_CONFIG_DIR=... word in the command moves claude's user settings too.
  const configWord = words.find((w) => w.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length);
  const configValue = configWord || env.CLAUDE_CONFIG_DIR;
  const configDir = configValue ? expandPath(configValue) : join(homedir(), ".claude");
  const files = [
    join(MANAGED, "managed-settings.json"),
    ...listJson(join(MANAGED, "managed-settings.d")),
    join(configDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  for (const f of files) if (setsAny(readJson(f), wanted)) return f;
  return null;
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
