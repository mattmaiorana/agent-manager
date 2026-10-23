// Transcripts, the view's side: the live transcript panel and the durable transcript note.

import { StringDecoder, fs, import_obsidian } from "../externals.js";
import type { Session } from "../sessions/controller.js";
import type { TranscriptMessage, TranscriptWrite } from "../types.js";
class ViewTranscriptMethods {
  // ---- Rendered transcript overlay ----
  // The session transcript rendered as real markdown, toggled from the strip.
  // An ABSOLUTE overlay inside termHost, so the terminal keeps its size and the
  // fit machinery never notices the toggle; the PTY and xterm run
  // untouched underneath, so flipping back is instant. Content comes from the
  // session's transcript JSONL (the same file the model badge resolves): a 1s
  // poll while open reads only APPENDED bytes from a tracked offset, parses the
  // new records, and appends rendered blocks — user turns as plain pre-wrap text
  // (prompts can contain XML-ish tags markdown would mangle), assistant text
  // through Obsidian's MarkdownRenderer (it IS markdown in the transcript), tool
  // calls as compact muted one-liners. Updates land per RECORD (as messages and
  // tool calls complete), not per token — the terminal stays the streaming view.
  toggleTranscript(this: Session): void {
    if (this._transcriptOpen) this.closeTranscript();
    else void this.openTranscript();
  }
  async openTranscript(this: Session): Promise<void> {
    if (!this.termHost) return;
    if (!this.transcriptHost) {
      this.transcriptHost = this.termHost.createDiv({ cls: "agent-manager-transcript-overlay" });
      this._transcriptBodyEl = this.transcriptHost.createDiv({ cls: "agent-manager-transcript-body markdown-rendered" });
    }
    this.transcriptHost.addClass("is-open");
    this._transcriptOpen = true;
    this.transcriptBtnEl?.addClass("is-active");
    this._syncTranscriptIcon();
    await this._refreshTranscript();
    if (!this._transcriptOpen) return; // closed during the first refresh: don't start the poll
    this.transcriptHost.scrollTop = this.transcriptHost.scrollHeight;
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
      // New, rotated, or truncated file: start over.
      this._transcriptFilePath = file;
      this._transcriptOffset = 0;
      this._transcriptDecoder = new StringDecoder("utf8");
      this._transcriptCarry = "";
      body.empty();
      // Cap the initial render on a big transcript: start near the end, at the
      // next full line. Reading and rendering many MB up front would stall the
      // UI for a file whose old turns are rarely the point.
      const CAP = 512 * 1024;
      if (stat.size > CAP) {
        this._transcriptOffset = stat.size - CAP;
        // Drop the first (partial) line only if the offset really landed mid-line:
        // if the byte before it is a newline, the chunk starts on a record boundary
        // and dropping would lose a whole record.
        this._transcriptSkipPartial = !this._byteIsNewline(file, this._transcriptOffset - 1);
        // The durable note holds the FULL conversation (its writer reads the
        // whole file), so the cap notice links there instead of dead-ending.
        const notice = body.createDiv({ cls: "agent-manager-transcript-notice" });
        notice.appendText("Transcript is large, so only the latest turns are shown here. ");
        const link = notice.createEl("a", { text: "Open the full transcript note", href: "#" });
        link.addEventListener("click", (ev) => { ev.preventDefault(); void this.openDurableTranscriptNote(); });
        notice.appendText(".");
      }
    }
    if (stat.size === this._transcriptOffset) return;
    let chunk = "";
    const fd = fs.openSync(file, "r");
    // The offset and the decoder are set above, when this file was first read.
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
    if (this._transcriptSkipPartial) {
      // The capped start almost certainly landed mid-record; drop up to the
      // first newline.
      lines.shift();
      this._transcriptSkipPartial = false;
    }
    const paneBackend = this.getBackendKey();
    const msgs: TranscriptMessage[] = [];
    for (const line of lines) {
      const m = this.plugin._tc().parseTranscriptRecord(line, paneBackend);
      if (m) msgs.push(m);
    }
    if (!msgs.length) return;
    // The overlay holds the body, so it's there when the body is.
    const scroller = this.transcriptHost as HTMLElement;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    for (const m of msgs) await this._appendTranscriptMessage(m);
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }
  // One transcript record → a normalized message, or null to skip. Dispatches
  // to the backend's format. Normalized shape:
  // { role: "user"|"assistant"|"boundary", text (user), parts (assistant:
  // [{kind:"md",text} | {kind:"tool",name,hint}]), uuid (the record's dedup
  // key) }. The `uuid` is whatever stable per-record key that backend has —
  // Claude's uuid, Codex's payload.id, agy's step_index — used for the
  // append-only <!-- pl-rec:KEY --> markers, so the field name is generic.
  async _appendTranscriptMessage(this: Session, m: TranscriptMessage): Promise<void> {
    const el = this._transcriptBodyEl;
    if (!el) return;
    if (m.role === "boundary") {
      el.createDiv({ cls: "agent-manager-transcript-boundary", text: "context compacted" });
      return;
    }
    const box = el.createDiv({ cls: "agent-manager-transcript-msg agent-manager-transcript-" + m.role });
    if (m.role === "user") {
      box.createDiv({ cls: "agent-manager-transcript-role", text: "You" });
      // Plain pre-wrap text, NOT markdown: prompts carry XML-ish wrappers and
      // literal markup that the renderer would mangle; exact text copies best.
      box.createDiv({ cls: "agent-manager-transcript-usertext", text: m.text });
      return;
    }
    for (const p of m.parts) {
      if (p.kind === "md") {
        const mdEl = box.createDiv({ cls: "agent-manager-transcript-md" });
        try {
          // A Component owns what the render makes: the view (a session controller isn't one).
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
  _byteIsNewline(file: string, pos: number): boolean {
    if (pos < 0) return true;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const b = Buffer.alloc(1);
      return fs.readSync(fd, b, 0, 1, pos) === 1 && b[0] === 0x0a;
    } catch { return false; }
    finally { if (fd != null) try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
  // This session's transcript file (shared by the model badge and the rendered
  // transcript): cached once resolved, re-resolved if it disappears.
  async _transcriptFile(this: Session): Promise<string | null> {
    let file = this._modelFile;
    if (!file || !fs.existsSync(file)) {
      file = await this._resolveModelFile();
      this._modelFile = file;
    }
    return file;
  }
  // ---- The transcript note ----
  // An append-only copy of the session in a vault note, so the conversation survives
  // what the CLI does to its own file (its cleanup of old transcripts, a rewrite).
  // Every turn is keyed by its record's id in a hidden marker, and only records not
  // written before are appended, so nothing is ever rewritten or removed. Runs on each
  // turn's end, once after a launch or resume, and when the tab closes; errors are
  // swallowed so a transcript hiccup never disturbs the session. Returns the writer's
  // { added, path } (the note's vault path), or null: a side chat that can't fork points
  // its new session at that path.
  async updateDurableTranscript(this: Session): Promise<TranscriptWrite | null> {
    try {
      const file = await this._transcriptFile();
      // Take the size BEFORE the write: the writer reads the file at its start and
      // then awaits vault I/O, so records appended during those awaits are not in
      // what it reconciled and must still read as growth next check.
      let size: number | null = null;
      try { if (file) size = fs.statSync(file).size; } catch { /* best effort */ }
      const backend = this.getBackendKey();
      const res = await this.plugin._tc().writeDurableTranscript(this.plugin._vaultTranscriptIO(), {
        ...this.plugin.transcriptTarget(),
        backend,
        sessionTitle: this.sessionTitle, // live capture keeps the session's name
        sessionId: this._ownSessionId(),
        transcriptFile: file,
        source: this._sourceLink(),
      });
      // An Antigravity session is listed in this vault once its id is known.
      if (backend === "antigravity" && file) this.plugin.rememberAntigravitySession(this._ownSessionId() || this.plugin._tc().deriveSessionId(file, backend)).catch(() => {});
      // Record the size we reconciled against, so the cheap growth check
      // (transcriptGrewSinceReconcile) can skip the full read until new records land.
      if (size != null) this._durableReconciledSize = size;
      return res;
    } catch { /* never let a transcript write disturb the session */ }
    return null;
  }
  // A link to the note this session was started from, for its transcript note's
  // `source` property, so the note's backlinks list every transcript of it, side chats
  // included. Linked from the transcripts folder, as Obsidian would write it there.
  _sourceLink(this: Session): string | null {
    const f = this._notePath && this.app.vault.getAbstractFileByPath(this._notePath);
    if (!(f instanceof import_obsidian.TFile)) return null;
    const from = `${this.plugin.folderOf("transcriptsFolder")}/x.md`;
    return `[[${this.app.metadataCache.fileToLinktext(f, from, true)}]]`;
  }
  // Has this session's transcript file grown since the last durable reconcile? One
  // statSync — the cheap gate every capture path (poll, focus, close) runs through
  // before paying for the full read. True when never reconciled, so a fresh or
  // repointed view reconciles on its first check.
  transcriptGrewSinceReconcile(this: Session): boolean {
    const file = this._modelFile;
    // No file resolved yet: worth a full try, which resolves it.
    if (!file) return true;
    let size: number;
    try { size = fs.statSync(file).size; } catch { return false; }
    return this._durableReconciledSize == null || size !== this._durableReconciledSize;
  }
  // Open this session's durable transcript note, written up to date first.
  async openDurableTranscriptNote(this: Session): Promise<void> {
    const file = await this._transcriptFile();
    if (!file) { new import_obsidian.Notice("No transcript yet."); return; }
    let res: TranscriptWrite | null = null;
    try { res = await this.updateDurableTranscript(); } catch { /* best effort */ }
    const id = this._ownSessionId() || this.plugin._tc().deriveSessionId(file, this.getBackendKey());
    const af = (res && res.path && this.app.vault.getAbstractFileByPath(res.path)) || this.plugin.findTranscriptNoteBySessionId(id);
    // A note: the writer's, or the one found by its id (a folder at the writer's path would
    // be no note to open).
    if (!(af instanceof import_obsidian.TFile)) { new import_obsidian.Notice("Transcript note not written yet."); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(af);
  }
}
export { ViewTranscriptMethods };
