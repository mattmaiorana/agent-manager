
const BROWSER_VIEW_TYPE = "agent-manager-browser";
const SESSION_VIEW_TYPE = "agent-manager-session";
const PLAIN_TERMINAL_VIEW_TYPE = "agent-manager-terminal";
const DIALOG_RE = /do you trust|trust the files|trust (?:the )?(?:files|code) in|trust this (?:folder|workspace|directory)|workspace trust|trust this project|bypass permissions mode|enter to confirm|update available|press enter to continue|skip until next version/i;
const RC_PANEL_RE = /^\s*(?:[❯›>]\s*)?(?:\d+\.\s*)?Disconnect this\b[^\n]*$[\s\S]*^\s*Enter to select\b/m;
export { BROWSER_VIEW_TYPE, DIALOG_RE, RC_PANEL_RE, PLAIN_TERMINAL_VIEW_TYPE, SESSION_VIEW_TYPE };
