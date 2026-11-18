
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { homedir, tmpdir } from "os";
import { join } from "path";

export const INPUT_VAR = "VAULT_TERMINAL_INPUT";
export const USER_VISUAL_VAR = "VAULT_TERMINAL_VISUAL";

export type Verdict = "leave" | "clear";

export const EDIT_SCRIPT = `#!/bin/sh
# Agent Manager's terminal: claude's external editor (Ctrl+G). On the
# terminal's own request it hands claude's input to the terminal; anything
# else gets the editor you would have had.
umask 077
f=
for a in "$@"; do f=$a; done
r=\${${INPUT_VAR}-}
case \${f##*/} in claude-prompt-*.md) ;; *) r= ;; esac
if [ -n "$r" ]; then
  if [ -f "$r.cancel" ]; then
    old=$(find "$r.cancel" -mtime -60s 2>/dev/null)
    rm -f "$r.cancel"
    [ -n "$old" ] && exit 0
  fi
  if mv "$r.req" "$r.taken" 2>/dev/null; then
    n=$(cat "$r.taken"); rm -f "$r.taken"
    case $n in *[!0-9a-f]*|'') exit 0 ;; esac
    cp "$f" "$r.$n.part" && mv "$r.$n.part" "$r.$n.out" || exit 0
    i=0
    while [ ! -f "$r.$n.verdict" ] && [ $i -lt 400 ]; do sleep 0.025; i=$((i+1)); done
    v=$(cat "$r.$n.verdict" 2>/dev/null)
    rm -f "$r.$n.verdict" "$r.$n.out"
    if [ "$v" = clear ]; then : > "$f"; fi
    exit 0
  fi
fi
e=\${${USER_VISUAL_VAR}-}
case $e in *vault-terminal-input/edit*) e= ;; esac
[ -n "$e" ] || e=\${EDITOR-}
case $e in *vault-terminal-input/edit*) e= ;; esac
if [ -z "$e" ]; then
  if [ -t 0 ]; then
    for c in code vi nano; do if command -v "$c" >/dev/null 2>&1; then e=$c; break; fi; done
  fi
  [ -n "$e" ] || e=vi
fi
case $e in code) e="code -w" ;; subl) e="subl --wait" ;; esac
exec /bin/sh -c "$e \\"\\$@\\"" sh "$@"
`;

export function channelDir(): string | null {
  const dir = join(tmpdir(), "vault-terminal-input");
  return /\s/.test(dir) ? null : dir;
}

export function editScriptPath(): string | null {
  const dir = channelDir();
  return dir ? join(dir, `edit-${createHash("sha256").update(EDIT_SCRIPT).digest("hex").slice(0, 12)}`) : null;
}

export function isEditScript(path: string): boolean {
  return /(^|\/)vault-terminal-input\/edit(-[0-9a-f]+)?$/.test(path.trim());
}

const STALE_MS = 60 * 60_000;

export function sweepChannel(): void {
  const dir = channelDir();
  if (!dir) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith("edit")) continue;
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
    } catch {
      /* empty */
    }
  }
}

export function ensureEditScript(): string | null {
  const dir = channelDir();
  const path = editScriptPath();
  if (!dir || !path) return null;
  try {
    if (existsSync(path)) return path;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const part = `${path}.${process.pid}.part`;
    writeFileSync(part, EDIT_SCRIPT, { mode: 0o700 });
    renameSync(part, path);
    return path;
  } catch {
    return null;
  }
}

export function newChannel(): string | null {
  const dir = channelDir();
  return dir ? join(dir, randomBytes(12).toString("hex")) : null;
}

export function channelAllowed(env: NodeJS.ProcessEnv): boolean {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  if (!ctrlGIsEditor(readText(join(config, "keybindings.json")))) return false;
  return claudeConfig(env).editorMode !== "vim";
}

export function editorContextOn(env: NodeJS.ProcessEnv): boolean {
  return claudeConfig(env).externalEditorContext === true;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function claudeConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readText(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json")) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function ctrlGIsEditor(file: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file || "{}");
  } catch {
    return true;
  }
  const blocks = (parsed as { bindings?: unknown }).bindings;
  if (!Array.isArray(blocks)) return true;
  for (const block of blocks as { context?: unknown; bindings?: unknown }[]) {
    if (block?.context !== "Global" && block?.context !== "Chat") continue;
    const keys = block.bindings;
    if (!keys || typeof keys !== "object") continue;
    for (const [key, action] of Object.entries(keys as Record<string, unknown>)) {
      const strokes = key.trim().toLowerCase().split(/\s+/).map((k) => k.replace(/\bcontrol\b/g, "ctrl"));
      if (strokes[0] !== "ctrl+g") continue;
      if (strokes.length > 1 || action !== "chat:externalEditor") return false;
    }
  }
  return true;
}

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

function put(path: string, body: string): void {
  const part = `${path}.part`;
  const fd = openSync(part, "w", 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  renameSync(part, path);
}

export function writeRequest(prefix: string, id: string): void {
  put(`${prefix}.req`, id);
}

const CANCEL_MS = 60_000;

export function cancelWaiting(prefix: string): boolean {
  const path = `${prefix}.cancel`;
  let age: number;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (age < CANCEL_MS) return true;
  try {
    unlinkSync(path);
  } catch {
    /* empty */
  }
  return false;
}

export function withdrawRequest(prefix: string): boolean {
  try {
    unlinkSync(`${prefix}.req`);
  } catch {
    return false;
  }
  try {
    put(`${prefix}.cancel`, "");
  } catch {
    /* empty */
  }
  return true;
}

export function readHandoff(prefix: string, id: string): string | null {
  try {
    return readFileSync(`${prefix}.${id}.out`, "utf8");
  } catch {
    return null;
  }
}

export function writeVerdict(prefix: string, id: string, verdict: Verdict): void {
  put(`${prefix}.${id}.verdict`, verdict);
}

const CONTEXT_HEAD = "# ─── Claude's last response (for reference; removed on save) ───";
const CONTEXT_MARKER = `# ─── Write your reply below this line ${"─".repeat(26)}`;

export function inputText(file: string, context: boolean): string {
  if (!context || !file.startsWith(CONTEXT_HEAD)) return file;
  const at = file.indexOf(CONTEXT_MARKER);
  return at < 0 ? file : file.slice(at + CONTEXT_MARKER.length).replace(/^\r?\n\r?\n?/, "");
}

export function afterReadBack(text: string): string {
  const end = text.endsWith("\r\n") ? "\r\n" : "\n";
  return text.endsWith(end) && !text.endsWith(end + end) ? text.slice(0, -end.length) : text;
}

export function holdsImage(text: string): boolean {
  return /\[Image #\d+\]/.test(text);
}
