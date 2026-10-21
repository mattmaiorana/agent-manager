// The view types, a timing constant, and the dialogs nothing is typed into.

// The session browser (the sidebar pages), a view of its own.
var BROWSER_VIEW_TYPE = "agent-manager-browser";
// A session tab: a view of the terminal (src/vault-terminal/), hosted by the plugin's VaultTerminal.
var SESSION_VIEW_TYPE = "agent-manager-session";
// The pending-input guards (the rename sent to Claude, the opening) report a skipped
// action, not a routine confirmation, so their Notice lingers longer than the ~5s
// default: long enough to read and act on before it clears.
var INPUT_GUARD_NOTICE_MS = 12000;
// A dialog a CLI shows before its prompt, which nothing may be typed into, since an
// Enter there answers it (controller.js, _dialogShowing): a folder trust question,
// Claude's warning for skipped permissions, Codex's "Update available" menu, any "Enter
// to confirm" menu. scripts/test-dialogs.mjs checks it.
var DIALOG_RE = /do you trust|trust the files|trust (?:the )?(?:files|code) in|trust this (?:folder|workspace|directory)|workspace trust|trust this project|bypass permissions mode|enter to confirm|update available|press enter to continue|skip until next version/i;
export { BROWSER_VIEW_TYPE, DIALOG_RE, INPUT_GUARD_NOTICE_MS, SESSION_VIEW_TYPE };
