
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

export function clipboardText(): string {
  return electronClipboard()?.readText() ?? "";
}

export function clipboardHasOnlyImage(): boolean {
  const clipboard = electronClipboard();
  if (!clipboard) return false;
  return clipboard.availableFormats().some((f) => f.startsWith("image/")) && !clipboard.readText();
}
