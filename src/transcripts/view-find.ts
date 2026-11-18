
import { import_obsidian } from "../externals.js";
import type { Session } from "../sessions/controller.js";

const MATCH = "agent-manager-find";
const CURRENT = "agent-manager-find-current";
const MAX_MATCHES = 2000;
type HighlightWindow = Window & { Highlight: typeof Highlight; CSS: typeof CSS };
const WINDOW_HIGHLIGHTS = new WeakMap<Window, { match: Highlight; current: Highlight }>();

class FindMethods {
  openFind(this: Session): void {
    const stage = this.termHost;
    if (!stage || !this._transcriptOpen) return;
    if (!this._findBarEl) {
      const bar = stage.createDiv({ cls: "vault-terminal-search agent-manager-find" });
      const input = bar.createEl("input", { type: "search", attr: { placeholder: "Find", "aria-label": "Find in transcript", spellcheck: "false" } });
      const count = bar.createSpan({ cls: "vault-terminal-search-count" });
      const earlier = bar.createEl("button", { cls: "agent-manager-find-earlier", text: "Search earlier turns" });
      earlier.addEventListener("click", () => { void this._findInEarlier(); });
      const button = (icon: string, label: string, fn: () => void): void => {
        const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
        import_obsidian.setIcon(b, icon);
        b.addEventListener("click", fn);
      };
      button("chevron-up", "Previous match", () => this.findStep(false));
      button("chevron-down", "Next match", () => this.findStep(true));
      button("x", "Close", () => this.closeFind());
      input.addEventListener("input", () => { this._findRun(true); });
      bar.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.isComposing || e.key === "Process" || e.key === "Dead") return;
        if (e.key === "Escape") { e.preventDefault(); this.closeFind(); }
        else if (e.key === "Enter" && e.target === input) { e.preventDefault(); this.findStep(!e.shiftKey); }
        else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "g") { e.preventDefault(); this.findStep(!e.shiftKey); }
        else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); input.select(); }
      });
      this._findBarEl = bar;
      this._findInputEl = input;
      this._findCountEl = count;
      this._findEarlierEl = earlier;
    }
    this._findBarEl.show();
    const sel = this._findBarEl.win.getSelection()?.toString() ?? "";
    const input = this._findInputEl as HTMLInputElement;
    if (sel && !sel.includes("\n") && this.transcriptHost?.contains(this._findBarEl.win.getSelection()?.anchorNode ?? null)) input.value = sel;
    input.focus();
    input.select();
    if (input.value) this._findRun(false);
  }

  closeFind(this: Session): void {
    if (!this._findBarEl?.isShown()) return;
    this._findBarEl.hide();
    this._setFindRanges([]);
    this._findAt = -1;
    if (this._transcriptOpen) this._designedBoxEl?.focus();
  }

  findStep(this: Session, forward: boolean): void {
    if (!this._findRanges?.length) { this._findRun(false); return; }
    const n = this._findRanges.length;
    this._findAt = ((this._findAt ?? -1) + (forward ? 1 : -1) + n) % n;
    this._showFindCurrent();
  }

  _findRun(this: Session, fresh: boolean, incremental = false): void {
    const body = this._findBodyEl();
    const q = this._findInputEl?.value ?? "";
    const old = this._findRanges ?? [];
    const keep = !fresh ? old[this._findAt ?? -1] : undefined;
    if (!body || !q) { this._setFindRanges([]); this._findAt = -1; this._syncFindCount(); return; }
    const kids = Array.from(body.children) as HTMLElement[];
    const from = incremental ? Math.max(0, Math.min(this._findSearched ?? 0, kids.length) - 1) : 0;
    const startEl = kids[from];
    const kept = incremental && startEl ? old.filter((r) => !(startEl.compareDocumentPosition(r.startContainer) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) && !startEl.contains(r.startContainer)) : [];
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const ranges: Range[] = kept;
    const doc = body.doc;
    for (let k = from; k < kids.length && ranges.length < MAX_MATCHES; k++) {
      const walker = doc.createTreeWalker(kids[k], NodeFilter.SHOW_TEXT);
      const nodes: { node: Text; start: number }[] = [];
      let full = "";
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) { nodes.push({ node: n, start: full.length }); full += n.nodeValue ?? ""; }
      if (!nodes.length) continue;
      const at = (pos: number): { node: Text; offset: number } => {
        let lo = 0, hi = nodes.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].start <= pos) lo = mid; else hi = mid - 1; }
        return { node: nodes[lo].node, offset: pos - nodes[lo].start };
      };
      re.lastIndex = 0;
      for (let m = re.exec(full); m && ranges.length < MAX_MATCHES; m = re.exec(full)) {
        if (!m[0]) { re.lastIndex++; continue; }
        const s0 = at(m.index), e0 = at(m.index + m[0].length - 1);
        const r = doc.createRange();
        r.setStart(s0.node, s0.offset);
        r.setEnd(e0.node, e0.offset + 1);
        ranges.push(r);
      }
    }
    this._findSearched = kids.length;
    this._setFindRanges(ranges);
    if (!ranges.length) this._findAt = -1;
    else if (keep) {
      const same = ranges.findIndex((r) => r.startContainer === keep.startContainer && r.startOffset === keep.startOffset);
      this._findAt = same >= 0 ? same : Math.min(this._findAt ?? 0, ranges.length - 1);
    } else if (fresh || (this._findAt ?? -1) < 0) {
      const top = this.transcriptHost?.getBoundingClientRect().top ?? 0;
      let lo = 0, hi = ranges.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ranges[mid].getBoundingClientRect().top < top) lo = mid + 1; else hi = mid; }
      this._findAt = lo < ranges.length ? lo : 0;
    }
    if (ranges.length) this._showFindCurrent(!fresh);
    else this._syncFindCount();
  }

  _findBodyEl(this: Session): HTMLElement | null {
    return this._transcriptBodyEl ?? null;
  }

  _setFindRanges(this: Session, ranges: Range[]): void {
    const hl = this._windowHighlights();
    if (hl) {
      for (const r of this._findRanges ?? []) hl.match.delete(r);
      if (this._findCurrentRange) hl.current.delete(this._findCurrentRange);
      for (const r of ranges) hl.match.add(r);
    }
    this._findCurrentRange = undefined;
    this._findRanges = ranges;
  }

  _showFindCurrent(this: Session, quiet = false): void {
    const r = this._findRanges?.[this._findAt ?? -1];
    const hl = this._windowHighlights();
    if (!r) { this._syncFindCount(); return; }
    if (hl) {
      if (this._findCurrentRange) hl.current.delete(this._findCurrentRange);
      hl.current.add(r);
    }
    this._findCurrentRange = r;
    const fold = r.startContainer.parentElement?.closest("details");
    if (fold && !fold.open) fold.open = true;
    const host = this.transcriptHost;
    if (!quiet && host) {
      const rect = r.getBoundingClientRect();
      const box = host.getBoundingClientRect();
      host.scrollTop += rect.top - box.top - host.clientHeight / 2;
    }
    this._syncFindCount();
  }

  _syncFindCount(this: Session): void {
    const n = this._findRanges?.length ?? 0;
    const q = this._findInputEl?.value ?? "";
    this._findCountEl?.setText(!q ? "" : n ? `${(this._findAt ?? 0) + 1} of ${n}${n >= MAX_MATCHES ? "+" : ""}` : "No matches");
    this._findEarlierEl?.toggleClass("is-shown", !!q && (this._transcriptStart ?? 0) > 0);
  }

  async _findInEarlier(this: Session): Promise<void> {
    const btn = this._findEarlierEl;
    if (btn) { btn.setText("Loading…"); btn.disabled = true; }
    try {
      for (let i = 0; i < 400 && (this._transcriptStart ?? 0) > 0 && this._transcriptOpen; i++) {
        const before = this._transcriptStart;
        await this._loadEarlierTranscript();
        if (this._transcriptStart === before) break;
      }
    } finally {
      if (btn) { btn.setText("Search earlier turns"); btn.disabled = false; }
    }
    this._findRun(false);
  }

  _findRefresh(this: Session): void {
    if (this._findBarEl?.isShown() && this._findInputEl?.value) this._findRun(false, true);
  }

  _windowHighlights(this: Session): { match: Highlight; current: Highlight } | null {
    const win = this.transcriptHost?.win as HighlightWindow | undefined;
    if (!win?.CSS || !("highlights" in win.CSS) || typeof win.Highlight !== "function") return null;
    let hl = WINDOW_HIGHLIGHTS.get(win);
    if (!hl) {
      hl = { match: new win.Highlight(), current: new win.Highlight() };
      win.CSS.highlights.set(MATCH, hl.match);
      win.CSS.highlights.set(CURRENT, hl.current);
      WINDOW_HIGHLIGHTS.set(win, hl);
    }
    return hl;
  }
}

export { FindMethods };
