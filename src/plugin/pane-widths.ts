
import type { WorkspaceSplit } from "obsidian";
import { edgeChanges, fitFixed, keepWidths, sharesFor, sharesOf, widthsFromShares, type SplitEdges } from "./pane-widths-core.js";
import type { AgentManagerPlugin } from "./main.js";

const MIN_COLUMN = 200;
const NEW_WINDOW_MS = 600;
const SETTLE_MS = 150;
const HELD_CLASS = "agent-manager-pane-held";

export interface HeldWidths { widths: number[]; hidden: boolean[]; timer: number }
export interface WatchedSplit { split: WorkspaceSplit; edges: SplitEdges; cols: unknown[]; held?: HeldWidths; keep?: number; squeezed?: boolean }
export interface PaneObserver { ro: ResizeObserver; since: number }

interface Column { containerEl?: HTMLElement; setDimension?(dimension: number | null): void; children?: unknown[]; type?: string; direction?: string }
const columnsOf = (split: WorkspaceSplit): Column[] => split.children ?? [];
const keptShare = (share: number): number => Math.min(99.9, Math.max(0.1, share));

class PaneWidthMethods {
  installPaneWidths(this: AgentManagerPlugin): void {
    const ws = this.app.workspace;
    const sync = () => this.syncPaneWidths();
    this._paneStopped = false;
    ws.onLayoutReady(sync);
    this.registerEvent(ws.on("layout-change", sync));
    this.registerEvent(ws.on("resize", sync));
    this.registerEvent(ws.on("window-close", sync));
    this.register(() => {
      this._paneStopped = true;
      for (const w of this._paneSplits?.values() ?? []) this.releaseWidths(w);
      for (const o of this._paneObservers?.values() ?? []) o.ro.disconnect();
      this._paneObservers = undefined;
      this._paneSplits = undefined;
    });
  }
  syncPaneWidths(this: AgentManagerPlugin): void {
    if (this._paneStopped) return;
    const ws = this.app.workspace;
    const watched = (this._paneSplits = this._paneSplits || new Map<HTMLElement, WatchedSplit>());
    const observers = (this._paneObservers = this._paneObservers || new Map<Window, PaneObserver>());
    const wanted = new Map<HTMLElement, WorkspaceSplit>();
    const walk = (item: Column) => {
      if (item.type === "tabs" || !Array.isArray(item.children)) return;
      if (item.containerEl && item.direction === "vertical") wanted.set(item.containerEl, item as unknown as WorkspaceSplit);
      for (const child of item.children as Column[]) walk(child);
    };
    if (this.pluginData.keepPaneWidths === true && ws.layoutReady) {
      for (const top of [ws.rootSplit, ...(ws.floatingSplit?.children ?? [])]) walk(top);
    }
    for (const [el, w] of watched) {
      if (wanted.get(el) === w.split) {
        const cols = columnsOf(w.split);
        if (!sameColumns(cols, w.cols)) { this.releaseWidths(w); w.cols = cols; w.edges = this.splitEdges(el); w.keep = undefined; w.squeezed = false; }
        continue;
      }
      this.releaseWidths(w);
      observers.get(el.win)?.ro.unobserve(el);
      watched.delete(el);
    }
    for (const [el, split] of wanted) {
      if (watched.has(el)) continue;
      let o = observers.get(el.win);
      if (!o) {
        const Observer = (el.win as Window & { ResizeObserver: typeof ResizeObserver }).ResizeObserver;
        o = { ro: new Observer((entries) => this.paneSplitResized(entries)), since: Date.now() };
        observers.set(el.win, o);
      }
      watched.set(el, { split, edges: this.splitEdges(el), cols: columnsOf(split) });
      o.ro.observe(el);
    }
    for (const [win, o] of observers) {
      if ([...watched.keys()].some((el) => el.win === win)) continue;
      o.ro.disconnect();
      observers.delete(win);
    }
  }
  splitEdges(this: AgentManagerPlugin, el: HTMLElement): SplitEdges {
    const win = el.win;
    return { width: el.clientWidth, left: el.getBoundingClientRect().left, outerWidth: win.outerWidth, screenLeft: win.screenX, screenRight: win.screenX + win.outerWidth };
  }
  paneSplitResized(this: AgentManagerPlugin, entries: ResizeObserverEntry[]): void {
    if (this._paneStopped) return;
    const main = this.app.workspace.rootSplit.containerEl?.win;
    let landed = false;
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const w = this._paneSplits?.get(el);
      if (!w) continue;
      const before = w.edges, after = this.splitEdges(el);
      w.edges = after;
      const cols = columnsOf(w.split);
      if (!sameColumns(cols, w.cols)) { this.releaseWidths(w); w.cols = cols; w.keep = undefined; w.squeezed = false; continue; }
      if (after.width === before.width || before.width <= 0 || after.width <= 0) continue;
      const since = this._paneObservers?.get(el.win)?.since ?? 0;
      if (el.win !== main && Date.now() - since < NEW_WINDOW_MS) continue;
      const quiet = this._paneQuiet;
      if (el.win === main && quiet) {
        if (el === this.app.workspace.rootSplit.containerEl && after.width !== quiet.width) landed = true;
        continue;
      }
      try { this.keepColumnWidths(w, cols, el, before, after); } catch (e) { console.error("[Agent Manager] keeping pane widths", e); }
    }
    if (landed) this._paneQuiet = undefined;
  }
  keepColumnWidths(this: AgentManagerPlugin, w: WatchedSplit, cols: Column[], el: HTMLElement, before: SplitEdges, after: SplitEdges): void {
    if (cols.length < 2) return;
    const grows = cols.map((c) => {
      const ce = c.containerEl;
      const g = ce ? parseFloat(ce.style.flexGrow || ce.win.getComputedStyle(ce).flexGrow) : NaN;
      return Number.isFinite(g) && g > 0 ? g : 0;
    });
    if (grows.every((g) => g <= 0)) return;
    const fixed = cols.map((c) => !!c.containerEl && c.containerEl === this._windowSidebarEl);
    const hidden = fixed.map((f) => f && !!this._windowSidebarHidden);
    const widths = (w.held && w.held.widths.length === cols.length ? w.held.widths : widthsFromShares(grows, hidden, before.width)).slice();
    const fixedAt = fixed.indexOf(true);
    if (fixedAt >= 0) {
      if (!w.squeezed || w.keep === undefined) w.keep = widths[fixedAt];
      widths[fixedAt] = w.keep;
    }
    const { dLeft, dRight } = edgeChanges(before, after);
    const rtl = el.win.getComputedStyle(el).direction === "rtl";
    let kept = keepWidths(widths, fixed, rtl ? dRight : dLeft, rtl ? dLeft : dRight, MIN_COLUMN);
    if (fixedAt >= 0 && !hidden[fixedAt] && w.keep !== undefined) {
      kept = fitFixed(kept ?? widths, fixedAt, after.width, w.keep);
      w.squeezed = kept[fixedAt] < w.keep - 0.5;
    }
    if (!kept) { this.releaseWidths(w); return; }
    const takes = kept.map((k, i) => !fixed[i] && k !== widths[i]);
    const takerShares = sharesOf(kept.filter((_, i) => takes[i]));
    let t = 0;
    cols.forEach((c, i) => {
      const ce = c.containerEl;
      if (!ce) return;
      if (takes[i]) {
        ce.removeClass(HELD_CLASS);
        c.setDimension?.(takerShares[t++]);
      } else {
        ce.addClass(HELD_CLASS);
        ce.setCssProps({ "--agent-manager-pane-width": `${kept[i]}px` });
      }
    });
    if (w.held) this.cancelTimeout(w.held.timer);
    w.held = { widths: kept, hidden, timer: this.scheduleTimeout(() => this.releaseWidths(w), SETTLE_MS) };
  }
  releaseWidths(this: AgentManagerPlugin, w: WatchedSplit): void {
    const held = w.held;
    if (!held) return;
    w.held = undefined;
    this.cancelTimeout(held.timer);
    const cols = (w.cols as Column[]).filter((c) => c.containerEl);
    const widths = cols.map((c, i) => (held.hidden[i] ? held.widths[i] : c.containerEl?.getBoundingClientRect().width ?? 0));
    const splitEl = w.split.containerEl;
    const total = splitEl?.clientWidth ?? 0;
    const shares = sharesFor(widths, held.hidden, total);
    if (splitEl) w.edges = this.splitEdges(splitEl);
    cols.forEach((c, i) => {
      c.containerEl?.removeClass(HELD_CLASS);
      c.setDimension?.(keptShare(shares[i]));
    });
    this.app.workspace.requestSaveLayout();
  }
}

function sameColumns(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

export { PaneWidthMethods };
