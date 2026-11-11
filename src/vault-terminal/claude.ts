
import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { expandPath, inlineSettings, withSessionSettings } from "./finder";
import { BRIDGE_ID, HOOK_ID } from "./status";

export interface ClaudeOptions {
  pictures?: boolean;
}

const SCROLL_SPEED = "CLAUDE_CODE_SCROLL_SPEED";
export const CLAUDE_SCROLL_SPEED = "0.25";
const ACCELERATION = "wheelScrollAccelerationEnabled";
const MANAGED = "/Library/Application Support/ClaudeCode";

export function prepareClaude(words: string[], env: NodeJS.ProcessEnv, cwd: string, options: ClaudeOptions): void {
  const extra: Record<string, unknown> = { preferredNotifChannel: "kitty", hooks: sessionHooks() };
  if (!userScrollSetting(words, env, cwd) && !settingsFileFlag(words)) {
    extra[ACCELERATION] = false;
    env[SCROLL_SPEED] = CLAUDE_SCROLL_SPEED;
  }
  const supported = options.pictures ? { ...SUPPORTED, [PICTURES]: "1" } : SUPPORTED;
  for (const [name, value] of Object.entries(supported)) {
    if (env[name] === undefined && !userSetting(words, env, cwd, { vars: [name] })) env[name] = value;
  }
  withSessionSettings(words, extra);
}

const HOOK_EVENTS: [string, string][] = [
  ["UserPromptSubmit", "working"],
  ["PostToolUse", "working"],
  ["PostToolUseFailure", "working"],
  ["PermissionRequest", "waiting"],
  ["Stop", "finished"],
  ["StopFailure", "error"],
];

export function sessionHooks(): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  const bridge = (from: string) => `\\u001b]99;i=${BRIDGE_ID};${from}=' "$b" '\\u0007`;
  const clean = `b=\${CLAUDE_CODE_BRIDGE_SESSION_ID-}; case $b in *[!A-Za-z0-9_-]*) b=;; esac; `;
  for (const [event, state] of HOOK_EVENTS) {
    const command = event === "PermissionRequest"
      ? `${clean}t=$(sed -e 's/"tool_input".*//' -n -e 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_.-]*\\)".*/\\1/p' | head -n 1); case $t in *[!A-Za-z0-9_.-]*) t=;; esac; printf '%s%s%s%s%s\\n' '{"terminalSequence":"\\u001b]99;i=${HOOK_ID};${state}=' "$t" '\\u0007${bridge("turn")}"}'`
      : event === "Stop"
        ? `${clean}s=${state}; LC_ALL=C tr -d '\\n\\r' | LC_ALL=C sed -e 's/.*"background_tasks"[[:space:]]*:/B:/' -e 's/"session_crons"[[:space:]]*:.*//' | LC_ALL=C grep -Eq '^B:.*("type"[[:space:]]*:[[:space:]]*"(shell|subagent|[a-z_]*workflow)"[^{}]*"status"[[:space:]]*:[[:space:]]*"(running|pending)"|"status"[[:space:]]*:[[:space:]]*"(running|pending)"[^{}]*"type"[[:space:]]*:[[:space:]]*"(shell|subagent|[a-z_]*workflow)")' && s=${state}=background; printf '%s%s%s%s%s\\n' '{"terminalSequence":"\\u001b]99;i=${HOOK_ID};' "$s" '\\u0007${bridge("turn")}"}'`
        : event === "PostToolUse"
          ? `${clean}s=${state}; LC_ALL=C tr -d '\\n\\r' | LC_ALL=C grep -Eq '"run_in_background"[[:space:]]*:[[:space:]]*true' && s=${state}=background; printf '%s%s%s%s%s\\n' '{"terminalSequence":"\\u001b]99;i=${HOOK_ID};' "$s" '\\u0007${bridge("turn")}"}'`
        : `${clean}printf '%s%s%s\\n' '{"terminalSequence":"\\u001b]99;i=${HOOK_ID};${state}\\u0007${bridge("turn")}"}'`;
    hooks[event] = [{ hooks: [{ type: "command", command }] }];
  }
  hooks.SessionStart = [{ hooks: [{ type: "command", command: `${clean}printf '%s%s%s\\n' '{"terminalSequence":"${bridge("start")}"}'` }] }];
  return hooks;
}

const SUPPORTED: Record<string, string> = {
  CLAUDE_CODE_FORCE_SYNC_OUTPUT: "1",
  CLAUDE_CODE_FORCE_STRIKETHROUGH: "1",
};

export const PICTURES = "CLAUDE_CODE_FORCE_TERMINAL_IMAGES";

function settingsFileFlag(words: string[]): boolean {
  const i = words.findIndex((w) => w === "--settings" || w.startsWith("--settings="));
  if (i < 0) return false;
  return !inlineSettings(words[i] === "--settings" ? words[i + 1] ?? "" : words[i].slice("--settings=".length));
}

interface Wanted {
  vars: string[];
  keys?: string[];
}

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

export function userScrollSetting(words: string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  return userSetting(words, env, cwd, { vars: [SCROLL_SPEED], keys: [ACCELERATION] });
}

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
