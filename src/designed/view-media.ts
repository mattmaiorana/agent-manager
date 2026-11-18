
import { fs, import_obsidian, path } from "../externals.js";
import type { Session } from "../sessions/controller.js";
import type { TranscriptImage, TranscriptMessage } from "../types.js";

const VAULT_IMAGE = /^(png|jpe?g|gif|webp|bmp|avif)$/i;
const AGENT_TAIL = 512 * 1024;
const AGENT_STEPS = 60;
const AGENT_STALE_MS = 120_000;
const HANDBACK_POINTER = /SubagentHandback call\)\. Read it there/;
const PENDING_RESULTS = 200;
const AGENT_TYPES: Record<string, [string, string]> = {
  "Explore": ["Explore", "Claude Code's built-in search agent: it reads and searches files, and changes nothing"],
  "Plan": ["Plan", "Claude Code's built-in planning agent: it reads the code and designs an approach, and changes nothing"],
  "general-purpose": ["General purpose", "Claude Code's built-in all-round agent, with the same tools as the session"],
  "claude-code-guide": ["Claude Code guide", "Claude Code's built-in agent for questions about Claude Code itself"],
  "statusline-setup": ["Status line setup", "Claude Code's built-in agent for setting up its status line"],
};

export interface AgentCard {
  id: string;
  el: HTMLElement;
  status: HTMLElement;
  latest: HTMLElement;
  description: string;
  link: HTMLElement;
  note: string | null;
  steps: HTMLElement;
  report: HTMLElement;
  file: string | null;
  size: number;
  done: boolean;
  background: boolean;
  at: number;
}

export interface AgentResult {
  stopped?: boolean; report: string; error: boolean; background: boolean; at?: string; durationMs?: number }

function blobUrl(img: TranscriptImage): string {
  const bin = atob(img.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: img.mediaType }));
}

function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Loadable = HTMLElement & { _load?: () => void };

class MediaMethods {
  _mediaObs(this: Session): IntersectionObserver | null {
    const host = this.transcriptHost;
    const win = host?.win;
    const IO = (win as unknown as { IntersectionObserver?: typeof IntersectionObserver } | undefined)?.IntersectionObserver;
    if (!host || !win || !IO) return null;
    if (this._mediaObserver && this._mediaObserverWin === win) return this._mediaObserver;
    this._mediaObserver?.disconnect();
    const obs = new IO((entries: IntersectionObserverEntry[]) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        (e.target as Loadable)._load?.();
      }
    }, { root: host, rootMargin: "400px" });
    this._mediaObserver = obs;
    this._mediaObserverWin = win;
    for (const t of Array.from(host.querySelectorAll<Loadable>("img.agent-manager-designed-thumb:not([data-loaded])"))) if (t._load) obs.observe(t);
    return obs;
  }

  _mediaThumb(this: Session, parent: HTMLElement, src: { image?: TranscriptImage; file?: InstanceType<typeof import_obsidian.TFile> }, label = ""): HTMLElement {
    const thumb = parent.createEl("img", { cls: "agent-manager-designed-thumb", attr: { alt: label || "Image", ...(label ? { title: label } : {}) } }) as HTMLImageElement & Loadable;
    const file = src.file ?? null;
    const keepBottom = () => {
      const host = this.transcriptHost;
      if (!host) return;
      const near = host.scrollHeight - host.scrollTop - host.clientHeight < 80;
      thumb.addEventListener("load", () => { if (near) host.scrollTop = host.scrollHeight; }, { once: true });
    };
    if (file) { keepBottom(); thumb.src = this.app.vault.getResourcePath(file); }
    else if (src.image) {
      let image: TranscriptImage | null = src.image;
      thumb._load = () => {
        if (!image) return;
        thumb.dataset.loaded = "1";
        const img = image;
        image = null;
        thumb._load = undefined;
        try {
          const url = blobUrl(img);
          (this._mediaUrls ??= []).push(url);
          keepBottom();
          thumb.src = url;
        } catch { thumb.alt = "Image that couldn't be read"; }
      };
      const obs = this._mediaObs();
      if (obs) obs.observe(thumb); else thumb._load();
    }
    thumb.addEventListener("click", () => { if (thumb.src) this._openImageViewer(thumb.src, file, label); });
    return thumb;
  }

  _toolImages(this: Session, el: HTMLElement, images: TranscriptImage[]): void {
    if (!images.length) return;
    let last = el.lastElementChild;
    while (last?.matches(".is-pending")) last = last.previousElementSibling;
    const summary = last?.matches(".agent-manager-designed-tools") ? last.querySelector(":scope > summary") : null;
    let holder: HTMLElement;
    if (summary) {
      holder = summary.querySelector<HTMLElement>(".agent-manager-designed-tools-thumbs") ?? (summary as HTMLElement).createSpan({ cls: "agent-manager-designed-tools-thumbs" });
      if (!holder.dataset.bound) {
        holder.dataset.bound = "1";
        holder.addEventListener("click", (e) => { e.preventDefault(); });
      }
    } else holder = el.createDiv({ cls: "agent-manager-designed-tool-images" });
    for (const img of images) this._mediaThumb(holder, { image: img });
  }

  _openImageViewer(this: Session, url: string, file: InstanceType<typeof import_obsidian.TFile> | null, label: string): void {
    const pane = this.termHost;
    if (!pane) return;
    pane.querySelector(".agent-manager-designed-viewer")?.remove();
    const viewer = pane.createDiv({ cls: "agent-manager-designed-viewer", attr: { tabindex: "-1", role: "dialog", "aria-label": label || "Image" } });
    viewer.createEl("img", { attr: { src: url, alt: label || "Image" } });
    const bar = viewer.createDiv({ cls: "agent-manager-designed-viewer-bar" });
    const close = () => {
      viewer.remove();
      (this._designedBoxEl && !this._designedBoxEl.disabled ? this._designedBoxEl : this.transcriptHost)?.focus({ preventScroll: true });
    };
    if (file) bar.createEl("button", { text: "Open in Obsidian" }).addEventListener("click", (e) => { e.stopPropagation(); close(); void this.plugin.openInNotesArea(file); });
    const x = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close" } });
    import_obsidian.setIcon(x, "x");
    viewer.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button")) close(); });
    x.addEventListener("click", (e) => { e.stopPropagation(); close(); });
    viewer.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } });
    viewer.focus({ preventScroll: true });
  }

  _vaultImagesIn(this: Session, holder: HTMLElement): void {
    const vault = this.plugin.getVaultPath();
    const cwd = this.workingDir || vault;
    for (const a of Array.from(holder.querySelectorAll<HTMLAnchorElement>("a"))) {
      const text = a.textContent ?? "";
      if (!text.startsWith("⁣")) continue;
      const shown = text.slice(1);
      a.setText(shown);
      let target = "";
      try { target = decodeURI(a.dataset.href || a.getAttribute("href") || ""); } catch { target = a.dataset.href || a.getAttribute("href") || ""; }
      target = target.replace(/#.*$/, "");
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const rel = path.relative(vault, path.resolve(cwd, target));
      const near = !rel.startsWith("..") && !path.isAbsolute(rel) ? this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(rel)) : null;
      const file = near instanceof import_obsidian.TFile ? near : this.app.metadataCache.getFirstLinkpathDest(target, "");
      if (!(file instanceof import_obsidian.TFile) || !VAULT_IMAGE.test(file.extension)) continue;
      const span = createSpan({ cls: "agent-manager-designed-reply-image" });
      a.replaceWith(span);
      this._mediaThumb(span, { file }, shown && shown !== file.name ? shown : file.name);
    }
  }

  _clearMedia(this: Session): void {
    this._mediaObserver?.disconnect();
    this._mediaObserver = undefined;
    this._mediaObserverWin = undefined;
    for (const u of this._mediaUrls?.splice(0) ?? []) URL.revokeObjectURL(u);
    this._agentCards?.clear();
    this._syncAgentPill();
    this._agentResults?.clear();
    this.termHost?.querySelector(".agent-manager-designed-viewer")?.remove();
  }

  _agentCard(this: Session, el: HTMLElement, id: string, description: string, type: string, at?: string): void {
    const card = el.createEl("details", { cls: "agent-manager-designed-subagent" });
    const summary = card.createEl("summary");
    import_obsidian.setIcon(summary.createSpan({ cls: "agent-manager-designed-subagent-icon" }), "bot");
    const head = summary.createDiv({ cls: "agent-manager-designed-subagent-head" });
    const kind = head.createDiv({ cls: "agent-manager-designed-subagent-kind" });
    const known = AGENT_TYPES[type];
    kind.setText(type ? `Sub-agent · ${known ? known[0] : type}` : "Sub-agent");
    kind.setAttr("aria-label", known ? known[1] : type ? `A sub-agent of type "${type}"` : "A sub-agent Claude started");
    head.createDiv({ cls: "agent-manager-designed-subagent-title", text: description || "Sub-agent" });
    const latest = head.createDiv({ cls: "agent-manager-designed-subagent-latest" });
    const spin = summary.createSpan({ cls: "agent-manager-designed-subagent-spin", attr: { "data-backend": this.getBackendKey() } });
    import_obsidian.setIcon(spin, "asterisk");
    const status = summary.createSpan({ cls: "agent-manager-designed-subagent-status", text: "Running" });
    import_obsidian.setIcon(summary.createSpan({ cls: "agent-manager-designed-subagent-chevron" }), "chevron-down");
    const steps = card.createDiv({ cls: "agent-manager-designed-subagent-steps" });
    const report = card.createDiv({ cls: "agent-manager-designed-subagent-report" });
    const link = card.createDiv({ cls: "agent-manager-designed-subagent-foot" });
    const anchor = link.createEl("a", { cls: "agent-manager-designed-subagent-link", text: "Open this sub-agent's transcript", attr: { "aria-label": "Open the sub-agent's transcript note" } });
    link.hide();
    const t = at ? Date.parse(at) : NaN;
    const state: AgentCard = { id, el: card, status, latest, description: description || "Sub-agent", link, note: null, steps, report, file: null, size: -1, done: false, background: false, at: Number.isNaN(t) ? Date.now() : t };
    (this._agentCards ??= new Map()).set(id, state);
    card.addEventListener("toggle", () => { if (card.open) this._agentRead(state, true); });
    anchor.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const f = state.note ? this.app.vault.getAbstractFileByPath(state.note) : null;
      if (f instanceof import_obsidian.TFile) void this.plugin.openInNotesArea(f);
    });
    const early = this._agentResults?.get(id);
    if (early) { this._agentResults?.delete(id); this._agentResult(id, early); }
    this._syncAgentPill();
  }

  _agentResult(this: Session, toolUseId: string, r: AgentResult): void {
    if (!toolUseId) return;
    const card = this._agentCards?.get(toolUseId);
    if (!card) {
      const pending = (this._agentResults ??= new Map());
      pending.set(toolUseId, r);
      if (pending.size > PENDING_RESULTS) pending.delete(pending.keys().next().value as string);
      return;
    }
    if (card.done) return;
    if (r.background && !r.error) { card.background = true; card.status.setText("Running in the background"); return; }
    card.done = true;
    card.el.addClass("is-done");
    card.el.removeClass("is-asking");
    if (card.file && this._cards?.size) {
      const sub = path.basename(card.file).replace(/^agent-|\.jsonl$/g, "");
      for (const c of [...this._cards.values()]) if (c.held.ask.agentId === sub) { c.held.answer(""); this._dropCard(c.held); }
    }
    const end = r.at ? Date.parse(r.at) : NaN;
    const ms = r.durationMs ?? (Number.isNaN(end) ? NaN : end - card.at);
    card.status.setText(r.stopped ? "Stopped" : `${r.error ? "Failed" : "Done"}${Number.isNaN(ms) ? "" : ` · ${took(ms)}`}`);
    card.latest.setText("");
    const report = HANDBACK_POINTER.test(r.report) ? this._agentHandback(card) ?? r.report : r.report;
    if (report.trim()) {
      card.report.empty();
      const md = card.report.createDiv({ cls: "agent-manager-transcript-md" });
      void this._renderReply(report, md).catch(() => { md.setText(report); });
    }
    if (card.el.hasAttribute("open")) this._agentRead(card, true);
    this._syncAgentPill();
  }

  _refreshAgentCards(this: Session): void {
    const host = this.transcriptHost;
    const near = !!host && host.scrollHeight - host.scrollTop - host.clientHeight < 80;
    const before = host?.scrollHeight ?? 0;
    for (const card of this._agentCards?.values() ?? []) {
      if (!card.done && card.el.isConnected) this._agentRead(card, card.el.hasAttribute("open"));
      else if (card.done && !card.note && card.el.isConnected) { card.file ??= this._agentFile(card.id); this._agentNote(card); }
    }
    this._syncAgentPill();
    if (near && host && host.scrollHeight !== before) host.scrollTop = host.scrollHeight;
  }

  _agentCardBySub(this: Session, sub: string): string {
    if (!sub) return "";
    for (const c of this._agentCards?.values() ?? []) {
      c.file ??= this._agentFile(c.id);
      if (c.file && path.basename(c.file) === `agent-${sub}.jsonl`) return c.id;
    }
    return "";
  }

  _agentHandback(this: Session, card: AgentCard): string | null {
    card.file ??= this._agentFile(card.id);
    if (!card.file) return null;
    let text = "";
    try {
      const size = fs.statSync(card.file).size;
      const from = Math.max(0, size - AGENT_TAIL);
      const fd = fs.openSync(card.file, "r");
      try {
        const buf = Buffer.alloc(size - from);
        text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from)).toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { return null; }
    let found: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.includes('"SubagentHandback"')) continue;
      try {
        const o = JSON.parse(line) as { message?: { content?: unknown } };
        const blocks = Array.isArray(o.message?.content) ? o.message.content as { type?: string; name?: string; input?: { message?: unknown } }[] : [];
        for (const b of blocks) if (b.type === "tool_use" && b.name === "SubagentHandback" && typeof b.input?.message === "string") found = b.input.message;
      } catch { /* empty */ }
    }
    return found;
  }

  _agentAsking(this: Session, card: AgentCard): boolean {
    if (!card.file || !this._cards?.size) return false;
    const id = path.basename(card.file).replace(/^agent-|\.jsonl$/g, "");
    return [...this._cards.values()].some((c) => c.held.ask.agentId === id);
  }

  _agentsRunning(this: Session): AgentCard[] {
    return [...(this._agentCards?.values() ?? [])].filter((c) => !c.done && c.el.isConnected && !c.el.hasClass("is-done"));
  }

  _syncAgentPill(this: Session): void {
    for (const c of this._agentCards?.values() ?? []) {
      const running = !c.done && !c.el.hasClass("is-done");
      c.el.toggleClass("is-running", running && !c.el.hasClass("is-asking"));
    }
    const el = this._designedAgentsEl;
    if (!el) return;
    const n = this._agentsRunning().length;
    el.toggleClass("is-shown", n > 0);
    el.querySelector(".agent-manager-designed-agents-text")?.setText(n === 1 ? "1 sub-agent running" : `${n} sub-agents running`);
  }

  _agentPillMenu(this: Session, e: MouseEvent): void {
    const running = this._agentsRunning();
    if (!running.length) return;
    const menu = new import_obsidian.Menu();
    const now = Date.now();
    for (const c of running) {
      const latest = c.latest.textContent?.trim();
      menu.addItem((i) => i
        .setTitle(`${c.description} · ${took(now - c.at)}${latest ? ` · ${latest.slice(0, 60)}` : ""}`)
        .setIcon("bot")
        .onClick(() => {
          c.el.setAttribute("open", "");
          c.el.scrollIntoView({ block: "center", behavior: "smooth" });
        }));
    }
    menu.showAtMouseEvent(e);
  }

  _agentNote(this: Session, card: AgentCard): void {
    if (card.note || !card.file) return;
    const id = path.basename(card.file).replace(/^agent-|\.jsonl$/g, "");
    const parent = this.plugin.findTranscriptNoteBySessionId(this._ownSessionId());
    if (!id || !parent) return;
    const folder = this.app.vault.getAbstractFileByPath(parent.path.replace(/\.md$/, ""));
    if (!(folder instanceof import_obsidian.TFolder)) return;
    const tc = this.plugin._tc();
    const ends = [`(${tc.noteIdKey(id)}).md`, `(${tc.noteIdKey(id, true)}).md`];
    const note = folder.children.find((c) => c instanceof import_obsidian.TFile && ends.some((e) => c.name.endsWith(e)));
    if (!note) return;
    card.note = note.path;
    card.link.show();
  }

  _agentFile(this: Session, id: string): string | null {
    const main = this._transcriptFilePath;
    if (!main) return null;
    const metas = (this._agentMetaIds ??= new Map<string, string>());
    const known = metas.get(id);
    if (known) return known;
    const dir = path.join(main.replace(/\.jsonl$/, ""), "subagents");
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(n)); } catch { return null; }
    const seen = new Set(metas.values());
    for (const n of names) {
      const file = path.join(dir, n.replace(/\.meta\.json$/, ".jsonl"));
      if (seen.has(file)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { toolUseId?: unknown };
        if (typeof m.toolUseId === "string") metas.set(m.toolUseId, file);
      } catch { /* empty */ }
    }
    return metas.get(id) ?? null;
  }

  _agentRead(this: Session, card: AgentCard, steps: boolean): void {
    card.file ??= this._agentFile(card.id);
    this._agentNote(card);
    let size = 0;
    let mtime = card.at;
    if (card.file) {
      try { const st = fs.statSync(card.file); size = st.size; mtime = st.mtimeMs; } catch { /* empty */ }
    }
    if (!card.done) {
      const asking = this._agentAsking(card);
      const before = !!this._programStartedAt && mtime < this._programStartedAt - 2000 && Date.now() - mtime > AGENT_STALE_MS;
      const stale = !asking && (before || (this.programState !== "working" && Date.now() - mtime > AGENT_STALE_MS));
      card.el.toggleClass("is-done", stale);
      card.el.toggleClass("is-asking", asking);
      card.status.setText(asking ? "Waiting for you" : stale ? "Stopped" : card.background ? "Running in the background" : "Running");
    }
    if (!card.file) return;
    const listed = card.steps.dataset.size === String(size);
    if (size === card.size && (!steps || listed)) return;
    card.size = size;
    const from = Math.max(0, size - AGENT_TAIL);
    let text = "";
    try {
      const fd = fs.openSync(card.file, "r");
      try {
        const buf = Buffer.alloc(size - from);
        const read = fs.readSync(fd, buf, 0, buf.length, from);
        text = buf.subarray(0, read).toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { return; }
    const lines = text.split("\n");
    if (from > 0) lines.shift();
    const msgs: TranscriptMessage[] = [];
    for (const line of lines) {
      const m = this.plugin._tc().parseTranscriptRecord(line, "claude", true);
      if (m) msgs.push(m);
    }
    const items: { tool: boolean; text: string }[] = [];
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        if (p.kind === "tool" && p.name === "SubagentHandback") continue;
        if (p.kind === "tool") items.push({ tool: true, text: p.hint ? `${p.name} · ${p.hint}` : p.name });
        else if (p.kind === "md") items.push({ tool: false, text: p.text.replace(/\s+/g, " ").trim() });
      }
    }
    const last = items[items.length - 1];
    if (!card.done) card.latest.setText(last ? (last.tool ? last.text : last.text.slice(0, 140)) : from > 0 ? "Working" : "Starting…");
    if (!steps) return;
    card.steps.empty();
    card.steps.dataset.size = String(size);
    const shown = items.slice(-AGENT_STEPS);
    if (items.length > shown.length || from > 0) card.steps.createDiv({ cls: "agent-manager-designed-subagent-more", text: "Earlier steps not shown" });
    for (const it of shown) card.steps.createDiv({ cls: it.tool ? "agent-manager-transcript-tool" : "agent-manager-designed-subagent-text", text: it.tool ? it.text : it.text.slice(0, 600) });
    if (!items.length) card.steps.createDiv({ cls: "agent-manager-designed-subagent-more", text: "Nothing yet." });
  }
}

export { MediaMethods };
