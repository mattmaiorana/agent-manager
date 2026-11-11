
import { createHash } from "crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { dirname, join } from "path";

const AS_USER = `if [[ -n "$VAULT_TERMINAL_USER_ZDOTDIR_SET" ]]; then ZDOTDIR="$VAULT_TERMINAL_USER_ZDOTDIR"; else unset ZDOTDIR; fi`;

const source = (name: string) => `${AS_USER}
[[ -r "\${ZDOTDIR-$HOME}/${name}" ]] && source "\${ZDOTDIR-$HOME}/${name}"
if [[ -n "\${ZDOTDIR+set}" ]]; then VAULT_TERMINAL_USER_ZDOTDIR="$ZDOTDIR"; VAULT_TERMINAL_USER_ZDOTDIR_SET=1; else VAULT_TERMINAL_USER_ZDOTDIR=""; VAULT_TERMINAL_USER_ZDOTDIR_SET=""; fi
`;

const RESTORE = `${AS_USER}
unset VAULT_TERMINAL_USER_ZDOTDIR VAULT_TERMINAL_USER_ZDOTDIR_SET VAULT_TERMINAL_ZDOTDIR
`;

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
  ".zshenv": `${source(".zshenv")}if [[ ! -o rcs ]] || { [[ ! -o login ]] && [[ ! -o interactive ]]; }; then
${RESTORE}else
  ZDOTDIR="$VAULT_TERMINAL_ZDOTDIR"
fi
`,
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
  ".zshrc": `${RESTORE}[[ -r "\${ZDOTDIR-$HOME}/.zshrc" ]] && source "\${ZDOTDIR-$HOME}/.zshrc"
${HOOKS}`,
};

function checkOwned(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path} isn't a folder`);
  if (st.uid !== userInfo().uid) throw new Error(`${path} belongs to someone else`);
  if (st.mode & 0o022) throw new Error(`${path} can be written by others`);
}

function checkParent(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new Error(`${path} isn't a folder`);
  const own = st.uid === userInfo().uid && !(st.mode & 0o022);
  if (!own && !(st.mode & 0o1000)) throw new Error(`${path} lets others replace what's in it`);
}

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
      /* empty */
    }
    const part = join(dir, `.${name}.${process.pid}.${Date.now()}`);
    writeFileSync(part, text, { mode: 0o600, flag: "wx" });
    renameSync(part, path);
  }
  return dir;
}

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
