
import { StringDecoder, fs, import_obsidian, path } from "../externals.js";
import { sentFileMarker, sentFilesIn } from "./sent-files.js";
import type { Session } from "../sessions/controller.js";
import type { TranscriptMessage, TranscriptWrite } from "../types.js";
import { notice } from "../vault-terminal/notice";

const FIRST_CHUNK = 512 * 1024;
const EARLIER_CHUNK = 256 * 1024;
const EARLIER_AT = 300;
class ViewTranscriptMethods {
  toggleTranscript(this: Session): void {
    if (this._transcriptOpen) this.closeTranscript();
    else void this.openTranscript();
  }
  async openTranscript(this: Session): Promise<void> {
    if (!this.termHost) return;
    if (!this.transcriptHost) {
      this.transcriptHost = this.termHost.createDiv({ cls: "agent-manager-transcript-overlay" });
      this._transcriptBodyEl = this.transcriptHost.createDiv({ cls: "agent-manager-transcript-body markdown-rendered" });
      const host = this.transcriptHost;
      this.view.registerDomEvent(host, "scroll", () => {
        if (host.scrollTop < EARLIER_AT) void this._loadEarlierTranscript();
      });
    }
    this.transcriptHost.addClass("is-open");
    this._transcriptOpen = true;
    this.transcriptBtnEl?.addClass("is-active");
    this._syncTranscriptIcon();
    await this._refreshTranscript();
    if (!this._transcriptOpen) return;
    this.transcriptHost.scrollTop = this.transcriptHost.scrollHeight;
    if (this.transcriptHost.scrollTop < EARLIER_AT) void this._loadEarlierTranscript();
    if (!this._transcriptTimer) {
      this._transcriptTimer = window.setInterval(() => {
        this._refreshTranscript().catch(() => {});
      }, 1000);
    }
  }
  closeTranscript(this: Session): void {
    if (this._transcriptTimer) {
      window.clearInterval(this._transcriptTimer);
      this._transcriptTimer = null;
    }
    if (!this._transcriptOpen) return;
    this._transcriptOpen = false;
    this._syncTranscriptIcon();
    this.transcriptHost?.removeClass("is-open");
    this.transcriptBtnEl?.removeClass("is-active");
    this.focusTerminal();
  }
  async _refreshTranscript(this: Session): Promise<void> {
    if (!this._transcriptOpen || !this._transcriptBodyEl) return;
    const file = await this._transcriptFile();
    const body = this._transcriptBodyEl;
    if (!file) {
      if (!this._transcriptFilePath && !body.hasChildNodes()) {
        body.createDiv({ cls: "agent-manager-transcript-notice", text: "No transcript yet. It appears after the session's first turn." });
      }
      return;
    }
    let stat: { size: number };
    try { stat = fs.statSync(file); } catch { return; }
    if (this._transcriptFilePath !== file || stat.size < (this._transcriptOffset || 0)) {
      this._transcriptFilePath = file;
      this._transcriptOffset = 0;
      this._transcriptDecoder = new StringDecoder("utf8");
      this._transcriptCarry = "";
      body.empty();
      this._transcriptGen = (this._transcriptGen || 0) + 1;
      this._transcriptStart = 0;
      this._transcriptEarlierEl = null;
      if (stat.size > FIRST_CHUNK) {
        const start = this._lineStartFrom(file, stat.size - FIRST_CHUNK, stat.size);
        this._transcriptOffset = start;
        this._transcriptStart = start;
        const notice = body.createDiv({ cls: "agent-manager-transcript-notice" });
        notice.appendText("Scroll up for earlier turns. ");
        const link = notice.createEl("a", { text: "Open the full transcript note", href: "#" });
        link.addEventListener("click", (ev) => { ev.preventDefault(); void this.openDurableTranscriptNote(); });
        notice.appendText(".");
        this._transcriptEarlierEl = notice;
      }
    }
    if (stat.size === this._transcriptOffset) return;
    let chunk = "";
    const fd = fs.openSync(file, "r");
    try {
      const len = stat.size - (this._transcriptOffset as number);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, this._transcriptOffset as number);
      chunk = (this._transcriptDecoder as InstanceType<typeof StringDecoder>).write(buf.subarray(0, read));
      (this._transcriptOffset as number) += read;
    } finally { fs.closeSync(fd); }
    const text = (this._transcriptCarry || "") + chunk;
    const lines = text.split("\n");
    this._transcriptCarry = lines.pop() || "";
    const paneBackend = this.getBackendKey();
    const msgs: TranscriptMessage[] = [];
    for (const line of lines) {
      const m = this.plugin._tc().parseTranscriptRecord(line, paneBackend);
      if (m) msgs.push(m);
    }
    if (!msgs.length) return;
    const scroller = this.transcriptHost as HTMLElement;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    for (const m of msgs) await this._appendTranscriptMessage(m);
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }
  async _appendTranscriptMessage(this: Session, m: TranscriptMessage, target: HTMLElement | null | undefined = this._transcriptBodyEl): Promise<void> {
    const el = target;
    if (!el) return;
    if (m.role === "boundary") {
      el.createDiv({ cls: "agent-manager-transcript-boundary", text: "context compacted" });
      return;
    }
    const box = el.createDiv({ cls: "agent-manager-transcript-msg agent-manager-transcript-" + m.role });
    if (m.role === "user") {
      box.createDiv({ cls: "agent-manager-transcript-role", text: "You" });
      box.createDiv({ cls: "agent-manager-transcript-usertext", text: m.text });
      return;
    }
    for (const p of m.parts) {
      if (p.kind === "md") {
        const mdEl = box.createDiv({ cls: "agent-manager-transcript-md" });
        try {
          const owner = this instanceof import_obsidian.Component ? this : this.view;
          await import_obsidian.MarkdownRenderer.render(this.app, p.text, mdEl, "", owner);
        } catch {
          mdEl.setText(p.text);
        }
      } else {
        box.createDiv({ cls: "agent-manager-transcript-tool", text: p.hint ? `${p.name} · ${p.hint}` : p.name });
      }
    }
  }
  async _loadEarlierTranscript(this: Session): Promise<void> {
    const file = this._transcriptFilePath;
    const body = this._transcriptBodyEl;
    const scroller = this.transcriptHost;
    const end = this._transcriptStart || 0;
    if (!file || !body || !scroller || end <= 0 || this._transcriptLoadingEarlier) return;
    this._transcriptLoadingEarlier = true;
    const gen = this._transcriptGen;
    let from = end;
    try {
      let size = EARLIER_CHUNK;
      from = this._lineStartFrom(file, end - size, end);
      while (from >= end && end - size > 0) {
        size *= 2;
        from = this._lineStartFrom(file, end - size, end);
      }
      if (from >= end) return;
      const buf = Buffer.alloc(end - from);
      let read = 0;
      const fd = fs.openSync(file, "r");
      try { read = fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
      const backend = this.getBackendKey();
      const holder = createDiv();
      for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
        const m = this.plugin._tc().parseTranscriptRecord(line, backend);
        if (m) await this._appendTranscriptMessage(m, holder);
      }
      if (this._transcriptGen !== gen || this._transcriptBodyEl !== body) return;
      const before = scroller.scrollHeight;
      const marker = this._transcriptEarlierEl;
      const anchor = marker && marker.parentElement === body ? marker.nextSibling : body.firstChild;
      while (holder.firstChild) body.insertBefore(holder.firstChild, anchor);
      this._transcriptStart = from;
      if (from === 0) { marker?.remove(); this._transcriptEarlierEl = null; }
      scroller.scrollTop += scroller.scrollHeight - before;
    } catch (e) {
      console.error("[Agent Manager] couldn't load earlier transcript turns:", e);
      return;
    } finally {
      this._transcriptLoadingEarlier = false;
    }
    if (from > 0 && this._transcriptOpen && scroller.scrollTop < EARLIER_AT) {
      window.setTimeout(() => { void this._loadEarlierTranscript(); }, 0);
    }
  }
  _lineStartFrom(file: string, pos: number, end: number): number {
    if (pos <= 0) return 0;
    if (this._byteIsNewline(file, pos - 1)) return pos;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(64 * 1024);
      for (let at = pos; at < end; at += buf.length) {
        const read = fs.readSync(fd, buf, 0, Math.min(buf.length, end - at), at);
        if (read <= 0) break;
        const nl = buf.subarray(0, read).indexOf(0x0a);
        if (nl !== -1) return Math.min(end, at + nl + 1);
      }
    } catch { /* empty */ }
    finally { if (fd != null) try { fs.closeSync(fd); } catch { /* empty */ } }
    return end;
  }
  _byteIsNewline(file: string, pos: number): boolean {
    if (pos < 0) return true;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const b = Buffer.alloc(1);
      return fs.readSync(fd, b, 0, 1, pos) === 1 && b[0] === 0x0a;
    } catch { return false; }
    finally { if (fd != null) try { fs.closeSync(fd); } catch { /* empty */ } }
  }
  async _transcriptFile(this: Session): Promise<string | null> {
    let file = this._modelFile;
    if (!file || !fs.existsSync(file)) {
      file = await this._resolveModelFile();
      this._modelFile = file;
    }
    return file;
  }
  async updateDurableTranscript(this: Session): Promise<TranscriptWrite | null> {
    try {
      const file = await this._transcriptFile();
      let size: number | null = null;
      try { if (file) size = fs.statSync(file).size; } catch { /* empty */ }
      const backend = this.getBackendKey();
      const ownId = this._ownSessionId();
      if (ownId && this._agentId !== undefined) await this.plugin.recordSessionAgent(ownId, this._agentId, { launchAgentId: this._launchAgentId });
      if (ownId && this._contextSource) await this.plugin.recordContextSource(ownId, this._contextSource);
      const agentId = this.agentId();
      const res = await this.plugin._tc().writeDurableTranscript(this.plugin._vaultTranscriptIO(), {
        ...this.plugin.transcriptTarget(agentId),
        agent: this.plugin.agentById(agentId)?.name || null,
        findExisting: () => this.plugin.findTranscriptNoteBySessionId(ownId)?.path || null,
        backend,
        sessionTitle: this.sessionTitle,
        sessionId: this._ownSessionId(),
        transcriptFile: file,
        source: this._sourceLink(),
      });
      if (backend === "antigravity" && file) this.plugin.rememberAntigravitySession(this._ownSessionId() || this.plugin._tc().deriveSessionId(file, backend)).catch(() => {});
      if (size != null) this._durableReconciledSize = size;
      if (res?.path && backend === "claude" && file && (size !== this._sentFilesScanned || this._sentFilesPending)) void this.saveSentFiles(file, res.path, size);
      if (res?.path && (backend === "claude" || backend === "codex") && file) await this.plugin.writeSubagentTranscripts(file, res.path, ownId || this.plugin._tc().deriveSessionId(file, backend), this.plugin.agentById(agentId)?.name || null, backend);
      return res;
    } catch { /* empty */ }
    return null;
  }
  async saveSentFiles(this: Session, transcriptFile: string, notePath: string, size: number | null = null): Promise<void> {
    if (this._sentFilesSaving || !this.plugin.sentFilesOn()) return;
    this._sentFilesSaving = true;
    try {
      let text = "";
      try { text = fs.readFileSync(transcriptFile, "utf8"); } catch { return; }
      const sent = sentFilesIn(text);
      this._sentFilesScanned = size;
      if (!sent.length) { this._sentFilesPending = false; return; }
      const adapter = this.app.vault.adapter;
      let noteText = "";
      try { noteText = await adapter.read(notePath); } catch { return; }
      let pending = false;
      for (const f of sent) {
        const marker = sentFileMarker(f.key);
        if (noteText.includes(marker)) continue;
        let data: Buffer;
        try { data = fs.readFileSync(f.path); } catch { pending = true; continue; }
        try {
          const source = this._notePath && this.app.vault.getAbstractFileByPath(this._notePath) ? this._notePath : notePath;
          const dest = await this.plugin.sentFileDestination(path.basename(f.path), source);
          const copy = await this.app.vault.createBinary(dest, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
          const link = this.app.metadataCache.fileToLinktext(copy, notePath, false);
          try {
            const tc = this.plugin._tc();
            const id = this._ownSessionId();
            const lock = id ? tc.transcriptLockKey(this.plugin.folderOf("transcriptsFolder"), id) : notePath;
            await tc.withTranscriptLock(lock, () => adapter.append((id && this.plugin.findTranscriptNoteBySessionId(id)?.path) || notePath, `\n![[${link}]]\n${marker}\n`));
          } catch (e) {
            try { await this.app.fileManager.trashFile(copy); } catch { /* empty */ }
            throw e;
          }
          noteText += marker;
        } catch {
          pending = true;
        }
      }
      this._sentFilesPending = pending;
    } finally {
      this._sentFilesSaving = false;
    }
  }
  _sourceLink(this: Session): string | null {
    if (!this._notePath && this._folderPath) {
      const dir = this.app.vault.getAbstractFileByPath(this._folderPath);
      return dir instanceof import_obsidian.TFolder ? `${dir.path}/` : null;
    }
    const f = this._notePath && this.app.vault.getAbstractFileByPath(this._notePath);
    if (!(f instanceof import_obsidian.TFile)) return null;
    const from = `${this.plugin.folderOf("transcriptsFolder")}/x.md`;
    return `[[${this.app.metadataCache.fileToLinktext(f, from, true)}]]`;
  }
  transcriptGrewSinceReconcile(this: Session): boolean {
    const file = this._modelFile;
    if (!file) return true;
    let size: number;
    try { size = fs.statSync(file).size; } catch { return false; }
    if (this._durableReconciledSize == null || size !== this._durableReconciledSize) return true;
    const backend = this.getBackendKey();
    return (backend === "claude" || backend === "codex") && this.plugin.subagentsGrew(file, backend, this._ownSessionId() || this.plugin._tc().deriveSessionId(file, backend));
  }
  async openDurableTranscriptNote(this: Session): Promise<void> {
    const file = await this._transcriptFile();
    if (!file) { notice("No transcript yet."); return; }
    let res: TranscriptWrite | null = null;
    try { res = await this.updateDurableTranscript(); } catch { /* empty */ }
    const id = this._ownSessionId() || this.plugin._tc().deriveSessionId(file, this.getBackendKey());
    const af = (res && res.path && this.app.vault.getAbstractFileByPath(res.path)) || this.plugin.findTranscriptNoteBySessionId(id);
    if (!(af instanceof import_obsidian.TFile)) { notice("Transcript note not written yet."); return; }
    await this.plugin.openInNotesArea(af);
  }
}
export { ViewTranscriptMethods };
