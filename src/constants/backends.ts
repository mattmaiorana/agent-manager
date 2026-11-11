
type BackendKey = "claude" | "codex" | "antigravity";
const REAL_BACKENDS: BackendKey[] = ["claude", "codex", "antigravity"];
function isBackendKey(key: unknown): key is BackendKey {
  return (REAL_BACKENDS as readonly unknown[]).includes(key);
}
interface StripCommand {
  cmd: string;
  what: string;
  args?: boolean;
}
interface CliBackend {
  label: string;
  binary: string;
  install: string;
  pathHints: string[];
  nameFlag?: string;
  resumeByIdFlag: string;
  addDirFlag: string;
  addDirWriteFlags?: string;
  badge?: string;
}
const STRIP_COMMANDS: Record<BackendKey, StripCommand[]> = {
  claude: [
    { cmd: "/model", what: "switch the model" },
    { cmd: "/effort", what: "set reasoning effort" },
    { cmd: "/compact", what: "compact the context (keeps a summary)" },
    { cmd: "/context", what: "show what fills the context window" },
    { cmd: "/usage", what: "plan usage and limits" },
    { cmd: "/cost", what: "this session's cost" },
    { cmd: "/status", what: "version, model, account, session" },
    { cmd: "/config", what: "settings" },
    { cmd: "/permissions", what: "permission rules" },
    { cmd: "/memory", what: "edit memory files" },
    { cmd: "/help", what: "every command" }
  ],
  codex: [
    { cmd: "/model", what: "switch the model or reasoning" },
    { cmd: "/approvals", what: "approval mode" },
    { cmd: "/compact", what: "compact the context" },
    { cmd: "/status", what: "session, model, token use" },
    { cmd: "/diff", what: "git diff of the work so far" },
    { cmd: "/review", what: "review the current changes" },
    { cmd: "/mention", what: "mention a file", args: true },
    { cmd: "/help", what: "every command" }
  ],
  antigravity: [
    { cmd: "/help", what: "every command" }
  ]
};
const INPUT_PASTE_MIN = 200;
const SIDE_SUFFIX_RE = / \(side chat(?: (\d+))?\)$/;
function sideChatName(subject: string, taken: Iterable<string | null | undefined>): string {
  let top = 0;
  for (const name of taken) {
    if (!name || !name.startsWith(subject)) continue;
    const m = name.slice(subject.length).match(/^ \(side chat(?: (\d+))?\)$/);
    if (m) top = Math.max(top, m[1] ? Number(m[1]) : 1);
  }
  return top ? `${subject} (side chat ${top + 1})` : `${subject} (side chat)`;
}
const CONTINUATION_SUFFIX_RE = / \(\d+\)$/;
function stripContinuationSuffix(title: string): string;
function stripContinuationSuffix<T>(title: T): T;
function stripContinuationSuffix(title: unknown): unknown { return typeof title === "string" ? title.replace(CONTINUATION_SUFFIX_RE, "") : title; }
const CLI_BACKENDS: Record<BackendKey, CliBackend> = {
  claude: {
    label: "Claude Code",
    binary: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    pathHints: ["~/.local/bin"],
    nameFlag: "-n",
    resumeByIdFlag: "-r",
    addDirFlag: "--add-dir",
  },
  codex: {
    label: "Codex",
    binary: "codex",
    install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    pathHints: [],
    resumeByIdFlag: "resume",
    addDirFlag: "--add-dir",
    addDirWriteFlags: "-s workspace-write",
  },
  antigravity: {
    label: "Antigravity",
    binary: "agy",
    install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    pathHints: ["~/.local/bin"],
    resumeByIdFlag: "--conversation",
    addDirFlag: "--add-dir",
    badge: "Antigravity",
  },
};
export { CLI_BACKENDS, INPUT_PASTE_MIN, REAL_BACKENDS, SIDE_SUFFIX_RE, STRIP_COMMANDS, isBackendKey, sideChatName, stripContinuationSuffix };
export type { BackendKey, CliBackend, StripCommand };
