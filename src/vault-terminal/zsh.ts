// Shell integration for zsh, an opt-in setting: the shell reports its current
// folder (OSC 7) and where each prompt starts and ends (OSC 133), which zsh
// doesn't do on its own.
//
// zsh reads its startup files from $ZDOTDIR, or $HOME when it's unset, each
// time it reaches the next one. The terminal points ZDOTDIR at a folder of
// small files that each source the user's own file of the same name, from
// where zsh would have looked, with ZDOTDIR exactly as it would have been
// (unset stays unset, empty stays empty). The user's files are never edited.
//
// ZDOTDIR goes back to what the user's files left it as at the end of
// .zprofile, the last file before /etc/zshrc, which reads ZDOTDIR (macOS's
// sets HISTFILE from it), and before the user's .zshrc; from there zsh reads
// the user's own .zshrc, .zlogin and .zlogout itself. The hooks are installed
// there too, and stay for the session. It goes back at once wherever zsh
// won't read another startup file: RCS turned off, or a shell that's neither
// login nor interactive. The .zshrc here is only for a non-login interactive
// shell, which the terminal doesn't start.

import { createHash } from "crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { dirname, join } from "path";

// Sets ZDOTDIR as the user's files left it: set (perhaps empty), or unset.
const AS_USER = `if [[ -n "$VAULT_TERMINAL_USER_ZDOTDIR_SET" ]]; then ZDOTDIR="$VAULT_TERMINAL_USER_ZDOTDIR"; else unset ZDOTDIR; fi`;

// Sources the user's own copy of a startup file from where zsh would look
// (an empty ZDOTDIR means /, as zsh reads it), and notes what their file
// left ZDOTDIR as.
const source = (name: string) => `${AS_USER}
[[ -r "\${ZDOTDIR-$HOME}/${name}" ]] && source "\${ZDOTDIR-$HOME}/${name}"
if [[ -n "\${ZDOTDIR+set}" ]]; then VAULT_TERMINAL_USER_ZDOTDIR="$ZDOTDIR"; VAULT_TERMINAL_USER_ZDOTDIR_SET=1; else VAULT_TERMINAL_USER_ZDOTDIR=""; VAULT_TERMINAL_USER_ZDOTDIR_SET=""; fi
`;

// ZDOTDIR as the user's files left it, from here on, and the terminal's own
// variables gone.
const RESTORE = `${AS_USER}
unset VAULT_TERMINAL_USER_ZDOTDIR VAULT_TERMINAL_USER_ZDOTDIR_SET VAULT_TERMINAL_ZDOTDIR
`;

// OSC 7 carries the folder as a file: URL; a % in it is encoded so it can't
// be read as an escape. OSC 133: A, a prompt starts; C, a command's output
// starts; D, it ended, with its status.
const HOOKS = `
autoload -Uz add-zsh-hook
typeset -g __vault_terminal_ran=0
__vault_terminal_precmd() {
  local s=$?
  (( __vault_terminal_ran )) && printf '\\e]133;D;%s\\e\\\\' "$s"
  __vault_terminal_ran=0
  printf '\\e]7;file://%s%s\\e\\\\' "$HOST" "\${PWD//\\%/%25}"
  printf '\\e]133;A\\e\\\\'
}
__vault_terminal_preexec() {
  __vault_terminal_ran=1
  printf '\\e]133;C\\e\\\\'
}
add-zsh-hook precmd __vault_terminal_precmd
add-zsh-hook preexec __vault_terminal_preexec
`;

const FILES: Record<string, string> = {
  // Next: .zprofile for a login shell, .zshrc for an interactive one.
  ".zshenv": `${source(".zshenv")}if [[ ! -o rcs ]] || { [[ ! -o login ]] && [[ ! -o interactive ]]; }; then
${RESTORE}else
  ZDOTDIR="$VAULT_TERMINAL_ZDOTDIR"
fi
`,
  // The last file before /etc/zshrc and the user's .zshrc. The integration
  // checks its own hooks are registered, and if they aren't, says so (OSC
  // 7766): the terminal then starts the shell again without it. The self-test's switch skips the hooks, and does nothing else.
  ".zprofile": `${source(".zprofile")}__vault_terminal_break="$VAULT_TERMINAL_TEST_BREAK_INTEGRATION"
unset VAULT_TERMINAL_TEST_BREAK_INTEGRATION
${RESTORE}if [[ -o interactive ]] && [[ -o rcs ]]; then
  if [[ -z "$__vault_terminal_break" ]]; then
${HOOKS}  fi
  # Registered, not only defined: add-zsh-hook may be missing from fpath.
  (( \${precmd_functions[(Ie)__vault_terminal_precmd]:-0} && \${preexec_functions[(Ie)__vault_terminal_preexec]:-0} )) || printf '\\e]7766;integration-failed\\e\\\\'
fi
unset __vault_terminal_break
`,
  // A non-login interactive shell only.
  ".zshrc": `${RESTORE}[[ -r "\${ZDOTDIR-$HOME}/.zshrc" ]] && source "\${ZDOTDIR-$HOME}/.zshrc"
${HOOKS}`,
};

/** Throws unless the path is a real folder (not a link) that this user owns and only they can write. */
function checkOwned(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path} isn't a folder`);
  if (st.uid !== userInfo().uid) throw new Error(`${path} belongs to someone else`);
  if (st.mode & 0o022) throw new Error(`${path} can be written by others`);
}

/**
 * Throws unless no one else can rename or replace things in this folder:
 * it's the user's own and only they can write it, or it has the sticky bit
 * (as /tmp does), so others can't move what isn't theirs.
 */
function checkParent(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new Error(`${path} isn't a folder`);
  const own = st.uid === userInfo().uid && !(st.mode & 0o022);
  if (!own && !(st.mode & 0o1000)) throw new Error(`${path} lets others replace what's in it`);
}

/**
 * The wrapper folder, in this user's temp folder, named for its contents, so
 * a file is written once and never changed: a terminal starting while another
 * writes can't read half a file. Each file is written whole and renamed into
 * place; one already there is used only if it's the user's, only they can
 * write it, and its contents are exactly these.
 */
export function zshIntegrationDir(): string {
  const hash = createHash("sha256").update(JSON.stringify(FILES)).digest("hex").slice(0, 12);
  const temp = tmpdir();
  checkParent(temp);
  const root = join(temp, `vault-terminal-${userInfo().uid}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  checkOwned(root);
  const dir = join(root, `zsh-${hash}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkOwned(dir);
  if (dirname(dir) !== root) throw new Error("unexpected wrapper folder");
  for (const [name, text] of Object.entries(FILES)) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isFile() && st.uid === userInfo().uid && !(st.mode & 0o022) && readFileSync(path, "utf8") === text) continue;
    } catch {
      // not there yet
    }
    const part = join(dir, `.${name}.${process.pid}.${Date.now()}`);
    writeFileSync(part, text, { mode: 0o600, flag: "wx" });
    renameSync(part, path);
  }
  return dir;
}

/** The environment a login zsh needs to read the wrapper. */
export function zshIntegrationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = zshIntegrationDir();
  const set = env.ZDOTDIR !== undefined;
  return {
    ...env,
    ZDOTDIR: dir,
    VAULT_TERMINAL_ZDOTDIR: dir,
    VAULT_TERMINAL_USER_ZDOTDIR: set ? env.ZDOTDIR : "",
    VAULT_TERMINAL_USER_ZDOTDIR_SET: set ? "1" : "",
  };
}
