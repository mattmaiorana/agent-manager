// Tests for the dialog guard (src/sessions/constants.ts, DIALOG_RE): the plugin types
// nothing into a CLI while one of these shows, since an Enter there answers it.
//   node scripts/test-dialogs.mjs
import { DIALOG_RE, RC_PANEL_RE } from "../src/sessions/constants.js";

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

// Codex's update menu at launch. The wording is approximate: what the guard keys on is
// the "Update available" heading and the menu's own lines.
const codexUpdate = [
  "  ✨ Update available! 0.162.0 -> 0.162.1",
  "",
  "  › 1. Update now",
  "    2. Skip",
  "    3. Skip until next version",
  "",
  "  Press enter to continue",
].join("\n");
check("Codex's update menu is a dialog", DIALOG_RE.test(codexUpdate));
check("its heading alone is enough", DIALOG_RE.test("Update available! 1.2.3 -> 1.2.4"));
check("a folder trust question is a dialog", DIALOG_RE.test("Do you trust the files in this folder?"));
check("Claude's skipped-permissions warning is a dialog", DIALOG_RE.test("WARNING: Claude Code running in Bypass Permissions mode"));
check("an idle prompt is not", !DIALOG_RE.test("> \n  ? for shortcuts"));
check("a reply about updates is not", !DIALOG_RE.test("I updated the package and the tests pass."));

// Claude's Remote Control panel while connected (2.1.317, recorded by hand).
const rcPanel = [
  "   Remote Control",
  "   This session is available in the Claude mobile app and at",
  "   https://claude.ai/code/session_01ABC",
  "",
  "   ❯ Disconnect this session",
  "     Show QR code",
  "     Continue",
  "",
  "   Enter to select · Esc to continue",
].join("\n");
check("Remote Control's panel is a dialog", RC_PANEL_RE.test(rcPanel));
check("a numbered choice and the foot are enough", RC_PANEL_RE.test("  › 1. Disconnect this session\n\n  Enter to select · Esc to continue"));
check("wrapped in a narrow tab, it still is", RC_PANEL_RE.test("   ❯ Disconnect this\n     session\n     Show QR\n     code\n\n   Enter to select ·\n   Esc to continue"));
check("its foot alone is not", !RC_PANEL_RE.test("> \n  Enter to select · Esc to continue\n"));
check("a reply listing its choices on lines of their own is not", !RC_PANEL_RE.test("The panel offers:\n\nDisconnect this session\nShow QR code\nContinue\n\n> "));
check("a reply about Remote Control is not", !RC_PANEL_RE.test("Remote Control is on. To stop, choose Disconnect this session in the panel.\n> "));
check("the reconnect reply is not", !RC_PANEL_RE.test("/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/x"));
check("the banner's /rc is not", !RC_PANEL_RE.test("@agent · My Vault · /rc"));

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
