/* eslint-disable no-control-regex -- the keys it reads are control characters */

const SHORT_LINE = 30;
const ESCAPE_TWICE_MS = 700;
class DraftTracker {
  declare _text: string;
  declare _unknown: boolean;
  declare _moved: boolean;
  _escapeAt = 0;
  constructor() {
    this.clear();
  }
  clear(): void {
    this._text = "";
    this._unknown = false;
    this._moved = false;
  }
  pending(): boolean {
    return this._unknown || this._text.length > 0;
  }
  edited(): void {
    if (this._text || this._unknown) this._unknown = true;
  }
  text(): string {
    return this._text;
  }
  feed(input: unknown, backend: string, now = Date.now()): void {
    if (typeof input !== "string" || !input) return;
    let data = input;
    if (data === "\x1b" && backend === "claude") {
      const twice = this._escapeAt > 0 && now - this._escapeAt <= ESCAPE_TWICE_MS;
      this._escapeAt = twice ? 0 : now;
      if (twice) this.clear();
      return;
    }
    this._escapeAt = 0;
    const pasteStart = "\x1b[200~";
    const pasteEnd = "\x1b[201~";
    if (data.startsWith(pasteStart) && data.endsWith(pasteEnd)) {
      this._text += data.slice(pasteStart.length, -pasteEnd.length);
      return;
    }
    if (data === "\x1b\r" || data === "\x1b\n") {
      this._text += "\n";
      return;
    }
    if (/[\r\n\x03]/.test(data)) {
      this.clear();
      return;
    }
    if (data === "\x15") {
      if (!this._unknown && !this._moved && !this._text.includes("\n") && this._text.length <= SHORT_LINE) this.clear();
      else if (this._text || this._unknown) this._unknown = true;
      return;
    }
    if (/^\x1b(?:\[|O)[AB]$/.test(data) || /^[\x10\x0e\x1f\x19\x16]$/.test(data)) {
      this._unknown = true;
      return;
    }
    if (/^\x1b(?:\[[0-9;]*|O)[CDHF]$|^\x1b[bf]$|^[\x01\x05\x02\x06]$/.test(data)) {
      if (this._text || this._unknown) this._moved = true;
      return;
    }
    if (/^[\x0b\x04]$/.test(data) || data === "\x1bd" || data === "\x1b[3~") {
      if (this._text || this._unknown) this._unknown = true;
      return;
    }
    if (data === "\x1b\x7f") data = "\x17";
    else if (data.startsWith("\x1b")) return;
    if (this._moved) {
      if (/[\x7f\x08\x17\x09]/.test(data) || /[^\x00-\x1f]/.test(data)) this._unknown = true;
      return;
    }
    for (const ch of data) {
      const c = ch.codePointAt(0) as number;
      if (c === 0x7f || c === 0x08) this._text = this._text.slice(0, -1);
      else if (c === 0x17) this._text = this._text.replace(/\s*\S*$/, "");
      else if (c === 0x09 && this._text) this._unknown = true;
      else if (c >= 0x20) this._text += ch;
    }
  }
}
export { DraftTracker };
/* eslint-enable no-control-regex -- end of the key handling */
