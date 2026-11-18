
import type { StreamBatch } from "./approvals-core.js";
import type { Session } from "../sessions/controller.js";

const LINE_MS = 150;
const CATCH_UP_MS = 1500;
const MIN_LINE_MS = 30;
const MAX_STEPS = CATCH_UP_MS / MIN_LINE_MS;
const MIN_PREFIX = 20;
const SWEEP_MS = 1500;
const RECENT_MS = 120_000;
const TAIL_CLS = ["agent-manager-designed-stream-tail", "agent-manager-transcript-md"];

export interface BlockScan {
  pos: number;
  end: number;
  fence: { ch: string; len: number } | null;
  blank: number;
  list: boolean;
}

export const newScan = (): BlockScan => ({ pos: 0, end: 0, fence: null, blank: -1, list: false });

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;

export function scanBlocks(text: string, scan: BlockScan, upto: number): number {
  for (;;) {
    const nl = text.indexOf("\n", scan.pos);
    if (nl < 0 || nl >= upto) break;
    const line = text.slice(scan.pos, nl);
    scan.pos = nl + 1;
    if (scan.fence) {
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (c && c[1][0] === scan.fence.ch && c[1].length >= scan.fence.len) scan.fence = null;
      continue;
    }
    if (line.trim() === "") { if (scan.end < scan.pos) scan.blank = scan.pos; continue; }
    const isList = LIST_ITEM.test(line);
    if (scan.blank >= 0) {
      if (!/^\s/.test(line) && !(scan.list && isList)) { scan.end = scan.blank; scan.list = false; }
      scan.blank = -1;
    }
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) scan.fence = { ch: f[1][0], len: f[1].length };
    scan.list = isList || (scan.list && /^\s/.test(line));
  }
  return scan.end;
}

export function nextReveal(text: string, shown: number, final: boolean): number {
  let p = shown;
  for (;;) {
    const nl = text.indexOf("\n", p);
    if (nl < 0) return final ? text.length : p;
    const blank = !text.slice(p, nl).trim();
    p = nl + 1;
    if (!blank || !text.slice(shown, p).trim()) {
      if (blank) continue;
      for (;;) {
        const n2 = text.indexOf("\n", p);
        if (n2 < 0 || text.slice(p, n2).trim()) return p;
        p = n2 + 1;
      }
    }
  }
}

export function linesLeft(text: string, shown: number, final: boolean): number {
  let n = 0;
  let p = shown;
  for (let nl = text.indexOf("\n", p); nl >= 0; nl = text.indexOf("\n", p)) {
    if (text.slice(p, nl).trim()) n++;
    p = nl + 1;
  }
  if (final && text.slice(p).trim()) n++;
  return n;
}

export function streamKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function streamMatches(streamText: string, recordKey: string): boolean {
  const sk = streamKey(streamText);
  return !!sk && (sk === recordKey || (sk.length >= MIN_PREFIX && recordKey.startsWith(sk)));
}

export interface StreamState {
  id: string;
  el: HTMLElement;
  done: HTMLElement;
  tail: HTMLElement;
  text: string;
  shown: number;
  rendered: number;
  tailTo: number;
  busy: boolean;
  record: HTMLElement | null;
  recordReady?: boolean;
  scan: BlockScan;
  final: boolean;
  at: number;
}

class StreamMethods {
  _streamBatch(this: Session, b: StreamBatch): void {
    const body = this._transcriptBodyEl;
    if (!body || !this._transcriptOpen || !this.designedOn() || this.plugin.pluginData.designedStream !== true) return;
    const ended = (this._streamsEnded ??= new Set<string>());
    if (ended.has(b.messageId)) { if (b.final) ended.delete(b.messageId); return; }
    const streams = (this._streams ??= new Map<string, StreamState>());
    let s = streams.get(b.messageId);
    if (!s) {
      if (b.index > 0 || !this.transcriptHost?.isShown()) { if (!b.final) this._endStream(b.messageId); return; }
      const el = body.createDiv({ cls: "agent-manager-transcript-msg agent-manager-transcript-assistant agent-manager-designed-streaming" });
      const done = el.createDiv({ cls: "agent-manager-transcript-md" });
      const tail = el.createDiv({ cls: TAIL_CLS });
      s = { id: b.messageId, el, done, tail, text: "", shown: 0, rendered: 0, tailTo: 0, busy: false, record: null, scan: newScan(), final: false, at: Date.now() };
      streams.set(b.messageId, s);
    }
    if (s.record) return;
    s.text += b.delta;
    if (b.final) s.final = true;
    for (const key of this._landedReplies ?? []) {
      if (streamMatches(s.text, key)) { this._endStream(s.id, s.final); return; }
    }
    this._streamTick();
  }

  _streamTick(this: Session): void {
    const win = this.transcriptHost?.win ?? window;
    if (this._streamTimer && this._streamTimerWin === win && !win.closed && Date.now() < (this._streamNextAt ?? 0) + 1000) return;
    if (this._streamTimer && this._streamTimerWin && !this._streamTimerWin.closed) this._streamTimerWin.clearTimeout(this._streamTimer);
    this._streamTimerWin = win;
    this._streamTimer = win.setTimeout(() => this._streamStep(), Math.max(0, (this._streamNextAt ?? 0) - Date.now()));
  }

  _streamStep(this: Session): void {
    this._streamTimer = 0;
    let shown = false;
    let left = 0;
    for (const s of this._streams?.values() ?? []) {
      const steps = Math.max(1, Math.ceil(linesLeft(s.text, s.shown, s.final) / MAX_STEPS));
      for (let i = 0; i < steps; i++) {
        const to = nextReveal(s.text, s.shown, s.final);
        if (to <= s.shown) break;
        s.shown = to;
        shown = true;
      }
      this._streamDraw(s);
      left = Math.max(left, linesLeft(s.text, s.shown, s.final));
    }
    if (!shown) return;
    this._streamNextAt = Date.now() + Math.max(MIN_LINE_MS, Math.min(LINE_MS, left ? CATCH_UP_MS / Math.min(left, MAX_STEPS) : LINE_MS));
    if (left) this._streamTick();
  }

  _streamDraw(this: Session, s: StreamState): void {
    if (s.busy) return;
    const whole = s.final && s.shown >= s.text.length;
    const end = whole ? s.shown : scanBlocks(s.text, s.scan, s.shown);
    const to = s.shown;
    if (end <= s.rendered && to === s.tailTo) {
      if (whole && s.record && s.recordReady) this._endStream(s.id, true);
      return;
    }
    s.busy = true;
    const block = end > s.rendered ? createDiv() : null;
    const tail = createDiv({ cls: TAIL_CLS });
    const render = (md: string, el: HTMLElement): Promise<unknown> => md.trim() ? this._renderReply(md, el).catch(() => { el.setText(md); }) : Promise.resolve();
    void Promise.all([block ? render(s.text.slice(s.rendered, end), block) : null, render(s.text.slice(end, to), tail)]).then(() => {
      if (this._streams?.get(s.id) !== s) return;
      const host = this.transcriptHost;
      const nearBottom = !!host && host.scrollHeight - host.scrollTop - host.clientHeight < 80;
      if (block) s.done.appendChild(block);
      s.tail.replaceWith(tail);
      s.tail = tail;
      s.rendered = end;
      s.tailTo = to;
      s.busy = false;
      if (nearBottom && host) host.scrollTop = host.scrollHeight;
      this._streamDraw(s);
    });
  }

  _streamLanded(this: Session, text: string, at: string | undefined, reply: HTMLElement): StreamState | null {
    if (this.plugin.pluginData.designedStream !== true) return null;
    const key = streamKey(text);
    const t = at ? Date.parse(at) : NaN;
    if (Number.isNaN(t) || t > Date.now() - RECENT_MS) {
      const landed = (this._landedReplies ??= new Set());
      landed.add(key);
      if (landed.size > 20) landed.delete(landed.values().next().value as string);
    }
    for (const s of [...(this._streams?.values() ?? [])]) {
      if (s.record || !streamMatches(s.text, key)) continue;
      if (!text.startsWith(s.text)) { this._endStream(s.id, s.final); return null; }
      s.text = text;
      s.final = true;
      s.record = reply;
      reply.hide();
      reply.before(s.el);
      return s;
    }
    return null;
  }

  _streamRecordReady(this: Session, s: StreamState): void {
    if (this._streams?.get(s.id) !== s) return;
    s.recordReady = true;
    this._streamDraw(s);
    this._streamTick();
  }

  _endStream(this: Session, id: string, final = false): void {
    const s = this._streams?.get(id);
    const host = this.transcriptHost;
    const nearBottom = !!s && !!host && host.scrollHeight - host.scrollTop - host.clientHeight < 80;
    s?.record?.show();
    s?.el.remove();
    if (nearBottom && host) host.scrollTop = host.scrollHeight;
    this._streams?.delete(id);
    if (final) return;
    const ended = (this._streamsEnded ??= new Set<string>());
    ended.add(id);
    if (ended.size > 100) ended.delete(ended.values().next().value as string);
  }

  _streamsToEnd(this: Session): void {
    const body = this._transcriptBodyEl;
    if (body) for (const s of this._streams?.values() ?? []) if (!s.record) body.appendChild(s.el);
  }

  _sweepStreams(this: Session): void {
    if (!this._streams?.size) { this._landedReplies?.clear(); return; }
    const before = Date.now();
    window.setTimeout(() => {
      void this._refreshOnce().then(() => {
        for (const s of [...(this._streams?.values() ?? [])]) if (s.at <= before && !s.record) this._endStream(s.id, s.final);
        if (this._streams?.size) this._streamTick();
        this._landedReplies?.clear();
      });
    }, SWEEP_MS);
  }

  _clearStreams(this: Session): void {
    for (const s of [...(this._streams?.values() ?? [])]) this._endStream(s.id, s.final);
    if (this._streamTimer) (this._streamTimerWin ?? window).clearTimeout(this._streamTimer);
    this._streamTimer = 0;
  }
}

export { StreamMethods };
