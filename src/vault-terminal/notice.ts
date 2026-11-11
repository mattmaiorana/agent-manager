import { Notice, setIcon } from "obsidian";

let config: () => { on: boolean; ms: number } = () => ({ on: true, ms: 5000 });

export function setNoticeConfig(get: () => { on: boolean; ms: number }): void {
  config = get;
}

export function noticesOn(): boolean {
  return config().on;
}

export function noticeMs(): number {
  return config().ms;
}

export function addCloseX(el: HTMLElement, close: () => void): void {
  el.addClass("has-close-x");
  const x = el.createSpan({ cls: "vault-terminal-close-x", attr: { "aria-label": "Dismiss" } });
  setIcon(x, "x");
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
}

let show: ((message: string) => void) | null = null;

export function setNoticeShow(fn: ((message: string) => void) | null): void {
  show = fn;
}

export function notice(message: string | DocumentFragment): void {
  const { on, ms } = config();
  if (!on) return;
  if (show && typeof message === "string") {
    show(message);
    return;
  }
  showNotice(message, ms);
}

export function showNotice(message: string | DocumentFragment, ms?: number): Notice {
  const shown = new Notice(message, ms);
  addCloseX(shown.messageEl.closest<HTMLElement>(".notice") ?? shown.messageEl, () => shown.hide());
  return shown;
}
