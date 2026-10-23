// What the user has typed into an agent's prompt and not sent, kept from the keys and
// pastes that reach it (never from the screen: Claude's ghost suggestions aren't typed).
// Used to keep the plugin's own typing (the opening, /rename) off a
// draft, and to ask before closing a tab that has one.
//
// Best effort, and wrong only on the safe side: when it can't know what the prompt holds
// (a line recalled from history, an undo, a yank, an edit after the cursor moved back
// into the text), it says there may be a draft until something empties the prompt for
// certain (Enter, Ctrl+C, and in Claude, Escape). Ctrl+U clears only a short one-line
// draft typed from its start with the cursor at its end, since it deletes back to the
// line's start (in Claude, of one wrapped line). A false "you have unsent text" costs a
// confirm; a missed draft costs the text.
/* eslint-disable no-control-regex -- the keys it reads are control characters */

const SHORT_LINE = 30;
class DraftTracker {
  // Set by clear(), from the constructor on.
  declare _text: string;
  declare _unknown: boolean;
  declare _moved: boolean;
  constructor() {
    this.clear();
  }
  clear(): void {
    this._text = "";
    this._unknown = false;
    // The cursor left the end of the text: edits from now on can't be followed.
    this._moved = false;
  }
  // Something might be in the prompt.
  pending(): boolean {
    return this._unknown || this._text.length > 0;
  }
  // The text known to be there ("" when unknown or empty).
  text(): string {
    return this._text;
  }
  // Input on its way to the program, as the terminal sends it. `backend` decides the
  // one key that differs: a lone Escape empties Claude's prompt and no other CLI's.
  feed(data: unknown, backend: string): void {
    if (typeof data !== "string" || !data) return;
    const pasteStart = "\x1b[200~";
    const pasteEnd = "\x1b[201~";
    // A paste: its text is the draft's, newlines and all.
    if (data.startsWith(pasteStart) && data.endsWith(pasteEnd)) {
      this._text += data.slice(pasteStart.length, -pasteEnd.length);
      return;
    }
    // Shift+Enter (and Option+Enter): a new line inside the prompt, never a submit.
    if (data === "\x1b\r" || data === "\x1b\n") {
      this._text += "\n";
      return;
    }
    // Enter submits; Ctrl+C clears the prompt; a lone Escape clears Claude's.
    if (/[\r\n\x03]/.test(data) || (data === "\x1b" && backend === "claude")) {
      this.clear();
      return;
    }
    // Ctrl+U deletes to the start of the line: all of a short one-line draft with the
    // cursor at its end, and otherwise an unknown part of it. Short, because Claude
    // deletes back only to the start of the wrapped screen line, and the tracker doesn't
    // know where the prompt wraps: a draft of up to
    // SHORT_LINE characters fits on one line of any terminal wide enough to use.
    if (data === "\x15") {
      if (!this._unknown && !this._moved && !this._text.includes("\n") && this._text.length <= SHORT_LINE) this.clear();
      else if (this._text || this._unknown) this._unknown = true;
      return;
    }
    // History (Up, Down, Ctrl+P, Ctrl+N), undo (Ctrl+_), yank (Ctrl+Y), and an image
    // pasted as Ctrl+V (Cmd+V with a picture, which the agent attaches) put something in
    // the prompt the keys don't show.
    if (/^\x1b(?:\[|O)[AB]$/.test(data) || /^[\x10\x0e\x1f\x19\x16]$/.test(data)) {
      this._unknown = true;
      return;
    }
    // Moving the cursor (Left, Right, Home, End, Option+arrows, Ctrl+A, Ctrl+E, Ctrl+B,
    // Ctrl+F) inside a draft: later edits land somewhere unknown.
    if (/^\x1b(?:\[[0-9;]*|O)[CDHF]$|^\x1b[bf]$|^[\x01\x05\x02\x06]$/.test(data)) {
      if (this._text || this._unknown) this._moved = true;
      return;
    }
    // Deleting forward (Ctrl+K, Ctrl+D, Option+Fn+Delete, Fn+Delete) changes a draft in
    // a way that can't be followed.
    if (/^[\x0b\x04]$/.test(data) || data === "\x1bd" || data === "\x1b[3~") {
      if (this._text || this._unknown) this._unknown = true;
      return;
    }
    // Other escape sequences (function keys, Option+key) don't type.
    if (data.startsWith("\x1b")) return;
    if (this._moved) {
      // An edit away from the end: the draft is something, but not what's tracked.
      if (/[\x7f\x08\x17]/.test(data) || /[^\x00-\x1f]/.test(data)) this._unknown = true;
      return;
    }
    for (const ch of data) {
      // A character of a string always has a code point.
      const c = ch.codePointAt(0) as number;
      if (c === 0x7f || c === 0x08) this._text = this._text.slice(0, -1);
      else if (c === 0x17) this._text = this._text.replace(/\s*\S*$/, "");
      else if (c >= 0x20) this._text += ch;
    }
  }
}
export { DraftTracker };
/* eslint-enable no-control-regex -- end of the key handling */
