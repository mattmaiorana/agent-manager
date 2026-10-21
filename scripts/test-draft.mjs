// Tests for src/sessions/draft.js, the unsent-text tracker behind the close confirm and
// the guards on the plugin's own typing: node scripts/test-draft.mjs
import { DraftTracker } from "../src/sessions/draft.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};
const after = (keys, backend = "claude") => {
  const d = new DraftTracker();
  for (const k of keys) d.feed(k, backend);
  return d;
};

check("typing is a draft", after(["h", "i"]).pending() && after(["h", "i"]).text() === "hi");
check("Enter sends it", !after(["h", "i", "\r"]).pending());
check("Shift+Enter is a new line, still a draft (the new terminal sends Escape then CR)", after(["a", "\x1b\r", "b"]).text() === "a\nb");
check("Shift+Enter alone leaves a draft of a new line", after(["\x1b\r"]).pending());
check("Backspace to empty is no draft", !after(["a", "\x7f"]).pending());
check("Ctrl+W deletes a word", after(["one two", "\x17"]).text() === "one");
check("Ctrl+C clears it, and Ctrl+U a one-line draft with the cursor at its end", !after(["x", "\x03"]).pending() && !after(["x", "\x15"]).pending());
check("Ctrl+U after moving to the start leaves the draft", after(["hello", "\x1b[H", "\x15"]).pending() && after(["hello", "\x01", "\x15"]).pending());
check("Ctrl+U on a draft of several lines may leave some of it", after(["a", "\x1b\r", "b", "\x15"]).pending());
check("Ctrl+U on a long one-line draft may leave its earlier wrapped lines", after(["x".repeat(240), "\x15"]).pending() && !after(["x".repeat(30), "\x15"]).pending());
check("Backspace after moving left: still a draft, not tracked text", after(["ab", "\x1b[D", "\x7f"]).pending() && after(["a", "\x1b[D", "\x7f"]).pending());
check("moving the cursor in an empty prompt changes nothing", !after(["\x1b[D", "\x01"]).pending());
check("Escape clears Claude's prompt, not Codex's", !after(["x", "\x1b"], "claude").pending() && after(["x", "\x1b"], "codex").pending());
check("a paste counts, newlines and all", after(["\x1b[200~line one\nline two\x1b[201~"]).text() === "line one\nline two");
check("a paste is not sent by its own newline", after(["\x1b[200~a\rb\x1b[201~"]).pending());
check("Up recalls history: maybe a draft, though nothing was typed", after(["\x1b[A"]).pending() && after(["\x1bOA"]).pending());
check("Down, Ctrl+P and Ctrl+N too", after(["\x1b[B"]).pending() && after(["\x10"]).pending() && after(["\x0e"]).pending());
check("undo (Cmd+Z sends Ctrl+_) and yank (Ctrl+Y) too", after(["\x1f"]).pending() && after(["\x19"]).pending());
check("a recalled line is cleared by Enter", !after(["\x1b[A", "\r"]).pending());
check("Left and Right only move", after(["ab", "\x1b[D"]).text() === "ab" && !after(["\x1b[D"]).pending());
check("Option+Left (Escape b) only moves", !after(["\x1bb"]).pending());
check("an image pasted as Ctrl+V counts as a draft (Antigravity review)", after(["\x16"]).pending());
check("deleting forward leaves a draft unknown, and does nothing to an empty prompt", after(["ab", "\x01", "\x0b"]).pending() && after(["ab", "\x1b[3~"]).pending() && !after(["\x0b"]).pending());
check("clear() empties it", (() => { const d = after(["x", "\x1b[A"]); d.clear(); return !d.pending(); })());

console.log(failures ? `\n${failures} failed` : "\nall draft tests pass");
process.exit(failures ? 1 : 0);
