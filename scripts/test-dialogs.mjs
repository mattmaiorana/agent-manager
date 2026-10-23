// Tests for the dialog guard (src/sessions/constants.ts, DIALOG_RE): the plugin types
// nothing into a CLI while one of these shows, since an Enter there answers it.
//   node scripts/test-dialogs.mjs
import { DIALOG_RE } from "../src/sessions/constants.js";

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

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
