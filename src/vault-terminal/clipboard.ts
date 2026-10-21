// The system clipboard through Electron, which Obsidian's renderer can reach.
// Unlike navigator.clipboard, it works whether or not the window has focus.

interface ElectronClipboard {
  readText(): string;
  writeText(text: string): void;
  availableFormats(): string[];
}

function electronClipboard(): ElectronClipboard | null {
  try {
    return (window as unknown as { require(m: string): { clipboard: ElectronClipboard } }).require("electron").clipboard;
  } catch {
    return null;
  }
}

export function copyText(text: string): void {
  const clipboard = electronClipboard();
  if (clipboard) clipboard.writeText(text);
  else void navigator.clipboard.writeText(text);
}

/** The clipboard's text, or "" if there's none or it can't be read. */
export function clipboardText(): string {
  return electronClipboard()?.readText() ?? "";
}

/** Whether the clipboard holds an image and no text. False if it can't be read. */
export function clipboardHasOnlyImage(): boolean {
  const clipboard = electronClipboard();
  if (!clipboard) return false;
  return clipboard.availableFormats().some((f) => f.startsWith("image/")) && !clipboard.readText();
}
