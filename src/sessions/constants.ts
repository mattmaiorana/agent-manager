// The view types, a timing constant, and the dialogs nothing is typed into.

// The session browser (the sidebar pages), a view of its own.
const BROWSER_VIEW_TYPE = "agent-manager-browser";
// A session tab: a view of the terminal (src/vault-terminal/), hosted by the plugin's VaultTerminal.
const SESSION_VIEW_TYPE = "agent-manager-session";
// The pending-input guards (the rename sent to Claude, the opening) report a skipped
// action, not a routine confirmation, so their Notice lingers longer than the ~5s
// default: long enough to read and act on before it clears.
const INPUT_GUARD_NOTICE_MS = 12000;
// A dialog a CLI shows before its prompt, which nothing may be typed into, since an
// Enter there answers it (controller.ts, _dialogShowing): a folder trust question,
// Claude's warning for skipped permissions, Codex's "Update available" menu, any "Enter
// to confirm" menu. scripts/test-dialogs.mjs checks it.
const DIALOG_RE = /do you trust|trust the files|trust (?:the )?(?:files|code) in|trust this (?:folder|workspace|directory)|workspace trust|trust this project|bypass permissions mode|enter to confirm|update available|press enter to continue|skip until next version/i;
// Claude's Remote Control panel, open while a session is connected (REFERENCE.md): two
// lines only it prints, each at the start of a line, its Disconnect choice and then its
// foot, so neither a reply that mentions Remote Control nor one that lists the panel's
// choices holds back the plugin's typing. Only their start: in a narrow tab Claude wraps
// them, and a miss here lets an Enter answer the panel, whose choice starts on Disconnect.
const RC_PANEL_RE = /^\s*(?:[❯›>]\s*)?(?:\d+\.\s*)?Disconnect this\b[^\n]*$[\s\S]*^\s*Enter to select\b/m;
export { BROWSER_VIEW_TYPE, DIALOG_RE, RC_PANEL_RE, INPUT_GUARD_NOTICE_MS, SESSION_VIEW_TYPE };
