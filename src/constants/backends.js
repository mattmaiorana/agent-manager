// The CLI backends: what each one is, how to find it, and the markers its sessions carry.

// The backends the plugin supports: each has a transcript reader, a transcript parser,
// and resume by id.
var REAL_BACKENDS = ["claude", "codex", "antigravity"];
// Common in-session slash commands per backend, for the strip's info menu. `args` means
// the command wants more text: it is typed into the prompt for the user to finish rather
// than sent. Curated, not exhaustive: `/help` in each CLI lists everything.
var STRIP_COMMANDS = {
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
var INPUT_PASTE_MIN = 200; // a line the plugin types that's longer than this goes in as a bracketed paste (controller.js, send)
// A side chat's name ends " (side chat)", as sideChat writes it.
var SIDE_SUFFIX_RE = / \(side chat\)$/;
// Claude names a compaction continuation by copying the title into the new file's first
// custom-title record with " (N)" appended (not always). Dropping it lets a continuation
// match its parent. The reader strips it ONLY for a file whose head proves it is a
// continuation (transcript-core's isCompactionContinuation: first user record is the
// compaction summary), so a user's own "(2026)" is left alone.
var CONTINUATION_SUFFIX_RE = / \(\d+\)$/;
function stripContinuationSuffix(title) { return typeof title === "string" ? title.replace(CONTINUATION_SUFFIX_RE, "") : title; }
var CLI_BACKENDS = {
  claude: {
    label: "Claude Code",
    binary: "claude",
    // The install command each CLI's own docs give for macOS (checked 2026-10-19).
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    pathHints: ["~/.local/bin"],
    // -n sets the session display name; -r <id> resumes a specific session.
    nameFlag: "-n",
    resumeByIdFlag: "-r",
    // --add-dir <folder> grants read and write to each added folder. No sandbox flag needed.
    addDirFlag: "--add-dir",
  },
  codex: {
    label: "Codex",
    binary: "codex",
    install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    pathHints: [],
    // `codex resume <uuid>` resumes a specific recorded session. Codex has no
    // launch-name flag, so the title lives in the opening message.
    resumeByIdFlag: "resume",
    // --add-dir <folder> grants reachability, and -s workspace-write is ALSO required
    // for writes: reads work by default under any sandbox mode, but a write without it
    // silently fails.
    addDirFlag: "--add-dir",
    addDirWriteFlags: "-s workspace-write",
  },
  antigravity: {
    label: "Antigravity",
    binary: "agy",
    install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    pathHints: ["~/.local/bin"],
    // Resume a conversation by uuid; no launch-name flag, so the title marker rides the
    // opening message, as for Codex. Sessions are read from agy's own
    // `brain/*/transcript.jsonl`, which records no working folder, so the plugin keeps
    // the ids it started in each vault (pluginData.antigravitySessions).
    resumeByIdFlag: "--conversation",
    // Adds each folder to agy's workspace, so reads there aren't "outside workspace",
    // which agy prompts for, per file. No sandbox-write flag (unlike Codex's -s).
    addDirFlag: "--add-dir",
    // Session-list badge shows the product name, not the `agy` binary.
    badge: "Antigravity",
  },
};
export { CLI_BACKENDS, INPUT_PASTE_MIN, REAL_BACKENDS, SIDE_SUFFIX_RE, STRIP_COMMANDS, stripContinuationSuffix };
