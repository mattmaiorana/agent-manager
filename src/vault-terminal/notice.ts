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

export interface Said {
  head: string;
  name?: string;
  detail?: string;
  lines?: string[];
}

export function drawSaid(parent: HTMLElement | DocumentFragment, said: Said): void {
  parent.createDiv({ cls: "vault-terminal-toast-title", text: said.head });
  if (said.name) parent.createDiv({ cls: "vault-terminal-toast-name", text: said.name });
  if (said.detail) parent.createDiv({ cls: "vault-terminal-toast-text", text: said.detail });
  for (const line of said.lines ?? []) parent.createDiv({ cls: "vault-terminal-toast-line", text: line });
}

export function saidBelow(said: Said): string {
  return [said.name, said.detail, ...(said.lines ?? [])].filter(Boolean).join("\n");
}

const LEAVE_MS = 2000;

export function closeAfter(el: HTMLElement, ms: number, close: () => void): () => void {
  if (!ms) return () => {};
  const win = el.win;
  let done = false;
  let id = win.setTimeout(close, ms);
  el.addEventListener("mouseenter", () => {
    win.clearTimeout(id);
  });
  el.addEventListener("mouseleave", () => {
    win.clearTimeout(id);
    if (!done) id = win.setTimeout(close, LEAVE_MS);
  });
  return () => {
    done = true;
    win.clearTimeout(id);
  };
}

let show: ((said: Said, onClick?: () => void) => void) | null = null;

export function setNoticeShow(fn: ((said: Said, onClick?: () => void) => void) | null): void {
  show = fn;
}

export function notice(message: string | Said, onClick?: () => void): void {
  const { on, ms } = config();
  if (!on) return;
  const said = typeof message === "string" ? { head: message } : message;
  if (show) {
    show(said, onClick);
    return;
  }
  showNotice(createFragment((f) => drawSaid(f, said)), ms);
}

export function showNotice(message: string | DocumentFragment, ms?: number, close?: () => void): Notice {
  const shown = new Notice(message, ms);
  addCloseX(shown.messageEl.closest<HTMLElement>(".notice") ?? shown.messageEl, close ?? (() => shown.hide()));
  return shown;
}
