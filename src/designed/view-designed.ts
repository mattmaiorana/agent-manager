
import { fs, import_obsidian, path } from "../externals.js";
import { prettyModelName } from "../sessions/transcript-files.js";
import { notice } from "../vault-terminal/notice";
import { userSetting } from "../vault-terminal/claude";
import { holdsImage } from "../vault-terminal/input-channel";
import { CLI_BACKENDS, REAL_BACKENDS, STRIP_COMMANDS } from "../constants/backends.js";
import { PLAN_MODES, TOKEN_VAR, allowBody, approvalHooks, cardKind, denyBody, describeTool, doneMatches, planAllowBody, planDenyBody, questionAnswer, questionsOf } from "./approvals-core.js";
import type { PermissionAsk } from "./approvals-core.js";
import type { ApprovalTab, HeldAsk } from "./approval-server.js";
import type { Session } from "../sessions/controller.js";
import type { HostLaunch } from "../vault-terminal/host";
import type { TranscriptMessage } from "../types.js";

const BOX_MAX_LINES = 8;
const MODELS: [string, string][] = [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];
const EFFORTS: [string, string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra"], ["max", "Max"]];

export interface ShownCard {
  held: HeldAsk;
  el: HTMLElement;
}

class DesignedViewMethods {
  designedOn(this: Session): boolean {
    return this.plugin.pluginData.designedView === true && REAL_BACKENDS.includes(this.getBackendKey()) && !this._inert;
  }

  designedReadOnly(this: Session): boolean {
    if (!this.designedOn()) return false;
    if (this.getBackendKey() !== "claude") return true;
    return this.plugin.pluginData.localServer !== true && this._approvalHooked !== true;
  }

  _applyDefaultView(this: Session): void {
    if (this._defaultViewDone) return;
    this._defaultViewDone = true;
    if (!this.designedOn() || this._approvalHooked !== true) { this._syncDesignedSwitch(); return; }
    const open = this._savedViewOpen ?? this.plugin.pluginData.designedDefault !== "terminal";
    this._savedViewOpen = undefined;
    if (!open) { this._syncDesignedSwitch(); return; }
    let tries = 0;
    const go = (): void => {
      if (this._closed || this._transcriptOpen) return;
      if ((this._puttingBack || this._savedDraft) && tries++ < 60) { window.setTimeout(go, 500); return; }
      void this.openTranscript();
    };
    window.setTimeout(go, 0);
  }

  _buildStripSwitch(this: Session, strip: HTMLElement): void {
    const sw = strip.createSpan({ cls: "agent-manager-strip-switch", attr: { role: "group", "aria-label": "View" } });
    sw.createSpan({ cls: "agent-manager-strip-switch-thumb" });
    for (const [view, icon, tip] of [["designed", "message-square", "Conversation view"], ["terminal", "terminal", "Terminal"]] as const) {
      const b = sw.createSpan({ cls: "agent-manager-strip-switch-opt", attr: { role: "button", "data-view": view, "aria-label": tip } });
      import_obsidian.setIcon(b, icon);
      this._stripTip(b, view === "designed" ? "Conversation view" : "Terminal");
      b.addEventListener("click", () => {
        if (b.hasClass("is-active")) return;
        sw.addClass("is-sliding");
        sw.setCssProps({ "--agent-manager-view-i": view === "designed" ? "0" : "1" });
        for (const o of Array.from(sw.querySelectorAll(".agent-manager-strip-switch-opt"))) o.toggleClass("is-active", o === b);
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        window.setTimeout(() => {
          if (this._closed) return;
          if (view === "designed" && !this._transcriptOpen) void this.openTranscript();
          if (view === "terminal" && this._transcriptOpen) this.closeTranscript();
        }, reduce ? 0 : 200);
      });
    }
    this._designedSwitchEl = sw;
    this._syncDesignedSwitch();
  }

  _syncDesignedSwitch(this: Session): void {
    const sw = this._designedSwitchEl;
    if (!sw?.isConnected) return;
    const designed = this._transcriptOpen || this._designedPending();
    sw.setCssProps({ "--agent-manager-view-i": designed ? "0" : "1" });
    for (const b of Array.from(sw.querySelectorAll<HTMLElement>(".agent-manager-strip-switch-opt"))) b.toggleClass("is-active", b.dataset.view === (designed ? "designed" : "terminal"));
  }

  _designedPending(this: Session): boolean {
    if (this._defaultViewDone || this._approvalHooked === false || !this.designedOn() || this.plugin.pluginData.localServer !== true || this.getBackendKey() !== "claude") return false;
    return this._savedViewOpen ?? this.plugin.pluginData.designedDefault !== "terminal";
  }

  _designedMoreMenu(this: Session, evt: MouseEvent): void {
    const menu = new import_obsidian.Menu();
    const key = this.activeBackendKey || this.getBackendKey();
    if (this.plugin.wrapMessage()) menu.addItem((i) => i.setTitle("Wrap").setIcon("package-check").onClick(() => { void this.sendWrap(); }));
    menu.addItem((i) => i.setTitle("Continue in a new session").setIcon("git-branch-plus").onClick(() => this._continueMenu(evt)));
    if (key === "claude" && this._quietTools && !this._transcriptOpen) menu.addItem((i) => i.setTitle(this._quietOn ? "Show tool output in full" : "Fold tool output").setIcon("fold-vertical").onClick(() => { void this.sendQuiet(); }));
    menu.addSeparator();
    if (!this._transcriptOpen && STRIP_COMMANDS[key]?.length) {
      menu.addItem((i) => i.setTitle(`Common ${CLI_BACKENDS[key].label} commands`).setDisabled(true));
      for (const c of this._stripCommandItems(key)) menu.addItem((i) => i.setTitle(`${c.cmd}  ·  ${c.what}`).setIcon("terminal").onClick(() => { void this._runStripCommand(c); }));
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle("Rename session").setIcon("pencil").onClick(() => this._startStripRename(this.stripEl?.querySelector<HTMLElement>(".agent-manager-strip-title"))));
    menu.showAtMouseEvent(evt);
  }

  async _appendDesignedMessage(this: Session, m: TranscriptMessage, el: HTMLElement): Promise<void> {
    if (m.role === "boundary") {
      el.createDiv({ cls: "agent-manager-transcript-boundary", text: "context compacted" });
      return;
    }
    if (m.role === "user") {
      if (/^\[Request interrupted by user/.test(m.text)) {
        el.createDiv({ cls: "agent-manager-designed-event", text: "Stopped" });
        return;
      }
      const box = el.createDiv({ cls: "agent-manager-transcript-msg agent-manager-transcript-user" });
      this._renderUserText(box, m.text);
      if (m.images?.length) {
        const row = box.createDiv({ cls: "agent-manager-designed-sent-files" });
        for (const img of m.images) this._mediaThumb(row.createDiv({ cls: "agent-manager-designed-chip is-image" }), { image: img });
      }
      this._copyButton(box, m.text.replace(/(?:^|\n\n)Attached:(?: [^\n]+|\n[\s\S]+)$/, ""), m.at);
      return;
    }
    let box: HTMLElement | null = null;
    for (const p of m.parts) {
      if (p.kind === "md") {
        box = null;
        const reply = el.createDiv({ cls: "agent-manager-transcript-msg agent-manager-transcript-assistant" });
        const handing = el === this._transcriptBodyEl ? this._streamLanded(p.text, m.at, reply) : null;
        const mdEl = reply.createDiv({ cls: "agent-manager-transcript-md" });
        this._copyButton(reply, p.text, m.at);
        try {
          await this._renderReply(p.text, mdEl, true);
        } catch {
          mdEl.setText(p.text);
        }
        if (handing) this._streamRecordReady(handing);
      } else if (p.kind === "result") {
        box = null;
        this._toolImages(el, p.images);
        if (p.agentId || p.error) this._agentResult(p.toolUseId || this._agentCardBySub(p.agentId ?? ""), { report: p.report ?? "", error: !!p.error, stopped: !!p.stopped, background: !!p.async, at: m.at, durationMs: p.durationMs });
      } else if (p.agent && p.id) {
        box = null;
        this._agentCard(el, p.id, p.agent.description, p.agent.type, m.at);
      } else {
        box ??= this._toolGroup(el);
        const list = box.querySelector<HTMLElement>(".agent-manager-designed-tools-list");
        list?.createDiv({ cls: "agent-manager-transcript-tool", text: p.hint ? `${p.name} · ${p.hint}` : p.name });
        let counts = TOOL_COUNTS.get(box);
        if (!counts) TOOL_COUNTS.set(box, counts = new Map<string, { n: number; hint: string }>());
        const k = toolKind(p.name);
        const c = counts.get(k);
        if (c) c.n++; else counts.set(k, { n: 1, hint: p.hint || "" });
        box.querySelector(".agent-manager-designed-tools-label")?.setText(toolSentence(counts));
      }
    }
  }

  _copyButton(this: Session, box: HTMLElement, source: string, at?: string): void {
    const row = box.createDiv({ cls: "agent-manager-designed-msg-actions" });
    const copy = row.createEl("button", { cls: "clickable-icon agent-manager-designed-copy", attr: { "aria-label": "Copy" } });
    const when = at ? timeTip(at) : "";
    if (when) row.createSpan({ cls: "agent-manager-designed-msg-time", text: `Sent ${when}` });
    import_obsidian.setIcon(copy, "copy");
    copy.addEventListener("click", () => { void navigator.clipboard.writeText(source).then(() => { import_obsidian.setIcon(copy, "check"); window.setTimeout(() => import_obsidian.setIcon(copy, "copy"), 1200); }, () => {}); });
  }

  _renderUserText(this: Session, box: HTMLElement, text: string): void {
    const m = /(?:^|\n\n)Attached:(?: ([^\n]+)|\n([\s\S]+))$/.exec(text);
    const cwd = this.workingDir || this.plugin.getVaultPath();
    const paths = m ? (m[1] ?? m[2] ?? "").split("\n").map((p) => p.trim()).filter(Boolean) : [];
    const fileOf = (p: string) => this.app.vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(path.relative(this.plugin.getVaultPath(), path.resolve(cwd, p))));
    const isFiles = paths.length > 0 && paths.every((p) => fileOf(p) instanceof import_obsidian.TFile);
    const body = m && isFiles ? text.slice(0, m.index) : text;
    if (body.trim()) box.createDiv({ cls: "agent-manager-transcript-usertext", text: body });
    if (!m || !isFiles) return;
    const chips = box.createDiv({ cls: "agent-manager-designed-sent-files" });
    for (const p of paths) {
      const file = fileOf(p);
      if (file instanceof import_obsidian.TFile && /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.extension)) {
        this._mediaThumb(chips.createDiv({ cls: "agent-manager-designed-chip is-image", attr: { title: p } }), { file }, file.name);
        continue;
      }
      const chip = chips.createDiv({ cls: "agent-manager-designed-chip", attr: { title: p } });
      import_obsidian.setIcon(chip.createSpan({ cls: "agent-manager-designed-chip-icon" }), "file");
      chip.createSpan({ cls: "agent-manager-designed-chip-name", text: p.replace(/^.*[\\/]/, "") });
      if (file instanceof import_obsidian.TFile) {
        chip.addClass("is-link");
        chip.addEventListener("click", () => { void this.plugin.openInNotesArea(file); });
      }
    }
  }

  _toolGroup(this: Session, el: HTMLElement): HTMLElement {
    let last = el.lastElementChild;
    while (last?.matches(".is-pending")) last = last.previousElementSibling;
    if (last?.matches(".agent-manager-designed-tools")) return last as HTMLElement;
    const group = el.createEl("details", { cls: "agent-manager-designed-tools" });
    const summary = group.createEl("summary");
    summary.createSpan({ cls: "agent-manager-designed-tools-label" });
    import_obsidian.setIcon(summary.createSpan({ cls: "agent-manager-designed-tools-chevron" }), "chevron-right");
    group.createDiv({ cls: "agent-manager-designed-tools-list" });
    return group;
  }

  async _approvalLaunch(this: Session): Promise<(Pick<HostLaunch, "claudeHooks" | "env"> & { approvals: boolean }) | null> {
    if (this.getBackendKey() !== "claude" || this._inert || this.plugin.pluginData.localServer !== true) return null;
    const approvals = this.designedOn() && !this.designedReadOnly();
    const server = await this.plugin.designedApprovals();
    if (!server) return null;
    if (!this._approvalTabId) this._approvalTabId = window.crypto.randomUUID().replace(/-/g, "");
    const base = server.base(this._approvalTabId);
    if (!base) return null;
    server.register(this._approvalTabId, this._approvalTab());
    this._hooksBlockedBy = hooksBlocked(this.workingDir || this.plugin.getVaultPath());
    return { approvals, claudeHooks: approvalHooks(base, approvals && this.plugin.pluginData.designedStream === true, approvals), env: { [TOKEN_VAR]: server.token } };
  }

  _approvalTab(this: Session): ApprovalTab {
    return {
      asked: (held) => { this._showCard(held); },
      ended: (held) => { this._dropCard(held); },
      finished: (done) => { this._toolFinished(done); },
      streamed: (batch) => { this._streamBatch(batch); },
      prompted: () => this.plugin.peerNote(this),
    };
  }

  _approvalClose(this: Session): void {
    window.clearTimeout(this._stopTimer);
    window.clearInterval(this._progressTimer);
    for (const u of this._chipUrls?.splice(0) ?? []) URL.revokeObjectURL(u);
    if (this._approvalTabId) this.plugin.approvals?.unregister(this._approvalTabId);
    this._cards?.clear();
  }

  _buildDesignedFooter(this: Session): void {
    const host = this.transcriptHost;
    if (!host || this._designedFooterEl) return;
    host.addClass("is-designed");
    const footer = host.createDiv({ cls: "agent-manager-designed-footer" });
    this._designedFooterEl = footer;
    this._designedCardsEl = footer.createDiv({ cls: "agent-manager-designed-cards" });
    const banner = footer.createDiv({ cls: "agent-manager-designed-banner" });
    banner.createSpan({ cls: "agent-manager-designed-banner-text", text: "Claude is asking something in the terminal." });
    banner.createEl("button", { text: "Show terminal" }).addEventListener("click", () => this.closeTranscript());
    this._designedBannerEl = banner;
    this._designedHookNoteEl = footer.createDiv({ cls: "agent-manager-designed-unhooked" });
    this._designedUnhookedEl = footer.createDiv({ cls: "agent-manager-designed-unhooked", text: "This session started without the view's approval hooks (before the setting was on, or reconnected to a running session), so prompts would go unseen here. Restart it to type here, or use the terminal." });
    const progress = footer.createDiv({ cls: "agent-manager-designed-progress", attr: { "data-backend": this.activeBackendKey || this.getBackendKey() } });
    import_obsidian.setIcon(progress.createSpan({ cls: "agent-manager-designed-progress-icon" }), "asterisk");
    progress.createSpan({ cls: "agent-manager-designed-progress-text", text: "Working" });
    this._designedWorkingEl = progress;
    const input = footer.createDiv({ cls: "agent-manager-designed-input" });
    this._designedChipsEl = input.createDiv({ cls: "agent-manager-designed-chips" });
    const line = input.createDiv({ cls: "agent-manager-designed-line" });
    const picker = line.createEl("input", { type: "file", cls: "agent-manager-designed-file", attr: { multiple: "" } });
    picker.addEventListener("change", () => { this._addAttachments(Array.from(picker.files ?? [])); picker.value = ""; });
    const plus = line.createEl("button", { cls: "clickable-icon agent-manager-designed-plus", attr: { "aria-label": "Add files or commands" } });
    import_obsidian.setIcon(plus, "plus");
    plus.addEventListener("click", (evt) => this._plusMenu(evt, picker));
    const box = line.createEl("textarea", { cls: "agent-manager-designed-box", attr: { rows: "1", placeholder: "⏎ to send, ⇧⏎ for a new line, @ for a file", "aria-label": "Message Claude" } });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); this.openFind(); return; }
      if (this._mentionKey(e)) return;
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.metaKey && !e.altKey && this._recall(e.key === "ArrowUp")) { e.preventDefault(); return; }
      if (e.key === "Escape" && !e.isComposing && !e.defaultPrevented && this.programState === "working") { e.preventDefault(); this._designedStop(); return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this._designedSend();
      }
    });
    box.addEventListener("input", () => { this._fitBox(); this._designedSay(""); this.app.workspace.requestSaveLayout(); this._syncMention(); });
    box.addEventListener("blur", () => { window.setTimeout(() => { if (activeDocument.activeElement !== box) this._closeMention(); }, 150); });
    box.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length || e.clipboardData?.getData("text/plain")) return;
      e.preventDefault();
      const stamp = window.moment().format("YYYY-MM-DD HHmmss");
      this._addAttachments(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `Pasted image ${stamp}${files.length > 1 ? ` ${i + 1}` : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }))));
    });
    this._designedBoxEl = box;
    if (this._designedDraftSaved) { box.value = this._designedDraftSaved; this._designedDraftSaved = undefined; }
    const action = line.createEl("button", { cls: "agent-manager-designed-send", attr: { "aria-label": "Send" } });
    action.addEventListener("click", () => {
      if (action.hasClass("is-stop")) this._designedStop();
      else void this._designedSend();
    });
    this._designedStopEl = action;
    const vaultDrag = (): { path: string }[] => {
      const d = (this.app as unknown as { dragManager?: { draggable?: { file?: { path: string }; files?: { path: string }[] } | null } }).dragManager?.draggable;
      return d?.files ?? (d?.file ? [d.file] : []);
    };
    this.view.registerDomEvent(host, "dragover", (e) => {
      if (this.designedReadOnly()) return;
      if (!e.dataTransfer?.types.includes("Files") && !vaultDrag().length) return;
      e.preventDefault();
      e.stopPropagation();
      input.addClass("is-dropping");
    });
    this.view.registerDomEvent(host, "dragleave", (e) => { if (!host.contains(e.relatedTarget as Node | null)) input.removeClass("is-dropping"); });
    this.view.registerDomEvent(host, "drop", (e) => {
      if (this.designedReadOnly()) return;
      input.removeClass("is-dropping");
      const files = Array.from(e.dataTransfer?.files ?? []);
      const notes = files.length ? [] : vaultDrag();
      if (!files.length && !notes.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (files.length) this._addAttachments(files);
      else this._insertMentions(notes.map((n) => n.path));
    });
    const latest = footer.createEl("button", { cls: "agent-manager-designed-latest", attr: { "aria-label": "Jump to the latest message" } });
    import_obsidian.setIcon(latest, "arrow-down");
    latest.addEventListener("click", () => { host.scrollTo({ top: host.scrollHeight, behavior: "smooth" }); });
    this.view.registerDomEvent(host, "scroll", () => {
      latest.toggleClass("is-shown", host.scrollHeight - host.scrollTop - host.clientHeight > 240);
    });
    const status = footer.createDiv({ cls: "agent-manager-designed-status" });
    const agents = status.createEl("button", { cls: "agent-manager-designed-agents", attr: { "aria-label": "Sub-agents running" } });
    import_obsidian.setIcon(agents.createSpan({ cls: "agent-manager-designed-agents-icon" }), "bot");
    agents.createSpan({ cls: "agent-manager-designed-agents-text" });
    agents.addEventListener("click", (e) => this._agentPillMenu(e));
    this._designedAgentsEl = agents;
    this._designedSayEl = status.createDiv({ cls: "agent-manager-designed-say" });
    const cli = this.activeBackendKey || this.getBackendKey();
    status.createSpan({ cls: "agent-manager-designed-cli", text: CLI_BACKENDS[cli].label, attr: { "data-backend": cli } });
    const model = status.createEl("button", { cls: "agent-manager-designed-model", attr: { "aria-label": "Model and effort" } });
    model.createSpan({ cls: "agent-manager-designed-model-label", text: "Model" });
    model.createSpan({ cls: "agent-manager-designed-model-effort" });
    model.addEventListener("click", () => this._toggleModelPop());
    this._designedModelEl = model;
    this._syncAgentPill();
    if (this.designedReadOnly()) {
      footer.addClass("is-readonly");
      box.disabled = true;
      box.placeholder = cli === "claude"
        ? "To type and answer approvals here, turn on Local server in Agent Manager's settings, then restart or resume this session. Until then, use the terminal view to send messages."
        : `Typing here is still being built for ${CLI_BACKENDS[cli].label}. Use the terminal view to send messages.`;
    }
    for (const c of this._cards?.values() ?? []) this._designedCardsEl.appendChild(c.el);
    this._renderChips();
    void this._syncModelPill(true);
    this._syncDesigned();
    this._fitBox();
  }

  _plusMenu(this: Session, evt: MouseEvent, picker: HTMLInputElement): void {
    const menu = new import_obsidian.Menu();
    const folder = this._attachFolder();
    menu.addItem((i) => i.setTitle(folder ? `Add files to ${folder}` : "Add files (set a folder in settings)").setIcon("paperclip").onClick(() => {
      if (!this._attachFolder()) { this._designedSay("Set an attachments folder in Settings → Agent Manager → Sessions, or on this profile's page, to add files."); return; }
      try { picker.showPicker(); } catch { picker.click(); }
    }));
    const own = this._notePath;
    const transcripts = `${this.plugin.folderOf("transcriptsFolder")}/`;
    const last = this.app.workspace.getLastOpenFiles().find((p) => p !== own && p.endsWith(".md") && !p.startsWith(transcripts) && this.app.vault.getAbstractFileByPath(p));
    const ownKind = own && this.plugin.isTicketNote(own) ? "this session's ticket" : "this session's note";
    for (const [p, what] of [[own, ownKind], [last, "the last open note"]] as const) {
      if (!p) continue;
      const name = p.replace(/^.*\//, "").replace(/\.md$/, "");
      menu.addItem((i) => i.setTitle(`Mention ${what}: ${name}`).setIcon("at-sign").onClick(() => this._insertMentions([p])));
    }
    const key = this.activeBackendKey || this.getBackendKey();
    if (STRIP_COMMANDS[key]?.length) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Commands").setDisabled(true));
      for (const c of this._stripCommandItems(key)) menu.addItem((i) => i.setTitle(`${c.cmd}  ·  ${c.what}`).setIcon("square-slash").onClick(() => {
        const box = this._designedBoxEl;
        if (!box) return;
        if (box.value.trim()) { this._designedSay("Send or clear your message first: a command goes on its own."); return; }
        box.value = `${c.cmd}${c.args ? " " : ""}`;
        this._fitBox();
        box.focus();
      }));
    }
    menu.showAtMouseEvent(evt);
  }

  _recall(this: Session, back: boolean): boolean {
    const box = this._designedBoxEl;
    const list = this._sentHistory ?? [];
    if (!box || !list.length) return false;
    if (box.value === "") this._recallAt = undefined;
    const at = this._recallAt;
    if (at === undefined ? box.value !== "" : box.value !== list[at]) return false;
    if (at !== undefined && (back ? box.selectionStart !== 0 : box.selectionEnd !== box.value.length)) return false;
    const next = at === undefined ? (back ? list.length - 1 : -1) : at + (back ? -1 : 1);
    if (next < 0 && back) return true;
    if (next < 0 || next >= list.length) { this._recallAt = undefined; box.value = ""; this._fitBox(); return true; }
    this._recallAt = next;
    box.value = list[next];
    this._fitBox();
    box.setSelectionRange(box.value.length, box.value.length);
    return true;
  }

  _fitBox(this: Session): void {
    const box = this._designedBoxEl;
    if (!box) return;
    box.setCssStyles({ height: "auto" });
    const line = parseFloat(getComputedStyle(box).lineHeight) || 20;
    const pad = box.offsetHeight - box.clientHeight + parseFloat(getComputedStyle(box).paddingTop) + parseFloat(getComputedStyle(box).paddingBottom);
    const rows = box.disabled && !box.value ? 3 : 1;
    box.setCssStyles({ height: `${Math.min(Math.max(box.scrollHeight, line * rows + pad), line * BOX_MAX_LINES + pad)}px` });
  }

  _designedSay(this: Session, text: string, info = false): void {
    this._designedSayEl?.setText(text);
    this._designedSayEl?.toggleClass("is-shown", !!text);
    this._designedSayEl?.toggleClass("is-info", info);
  }

  _syncDesigned(this: Session): void {
    if (!this._designedFooterEl) return;
    const state = this.programState;
    const cards = this._cards?.size ?? 0;
    const readOnly = this.designedReadOnly();
    const hooked = this._approvalHooked === true;
    const working = (hooked || readOnly) && state === "working" && !cards;
    this._designedFooterEl.toggleClass("is-unhooked", !hooked && !readOnly);
    this._designedUnhookedEl?.toggleClass("is-shown", !hooked && !readOnly);
    const blocked = hooked ? this._hooksBlockedBy : null;
    this._designedHookNoteEl?.toggleClass("is-shown", !!blocked);
    if (blocked) this._designedHookNoteEl?.setText(`Approval cards may not show here: Claude's settings limit hooks (${blocked.replace(/^.*[\\/]/, "")}). Approvals still work in the terminal.`);
    this._designedWorkingEl?.toggleClass("is-shown", working);
    if (state !== "working") this._workingSince = undefined;
    this._syncProgress(working && this._transcriptOpen === true);
    const prompt = !cards && (state === "waiting" || this._terminalPrompt === true);
    this._designedBannerEl?.toggleClass("is-shown", prompt);
    const who = CLI_BACKENDS[this.activeBackendKey || this.getBackendKey()]?.label ?? "Claude";
    this._designedBannerEl?.querySelector(".agent-manager-designed-banner-text")?.setText(state === "waiting" ? `${who} is asking something in the terminal.` : "The terminal is showing something for you.");
    const action = this._designedStopEl;
    if (action && action.hasClass("is-stop") !== working) {
      action.toggleClass("is-stop", working);
      action.disabled = false;
      action.setAttribute("aria-label", working ? "Stop" : "Send");
      import_obsidian.setIcon(action, working ? "square" : "arrow-up");
    } else if (action && !action.querySelector("svg")) import_obsidian.setIcon(action, "arrow-up");
  }

  _checkTerminalPrompt(this: Session): void {
    const now = Date.now();
    if (this._promptCheckedAt !== undefined && this.lastOutputAt === this._promptCheckedAt && now - (this._promptCheckedNow ?? 0) < 5000) return;
    this._promptCheckedAt = this.lastOutputAt;
    this._promptCheckedNow = now;
    const showing = this.running && this._dialogShowing();
    if (showing === this._terminalPrompt) return;
    this._terminalPrompt = showing;
    this._syncDesigned();
  }

  _syncProgress(this: Session, working: boolean): void {
    const text = this._designedWorkingEl?.querySelector(".agent-manager-designed-progress-text");
    if (!working) {
      window.clearInterval(this._progressTimer);
      this._progressTimer = undefined;
      return;
    }
    this._workingSince ??= Date.now();
    const tick = (): void => {
      const s = Math.floor((Date.now() - (this._workingSince ?? Date.now())) / 1000);
      text?.setText(s < 1 ? "Working" : `Working · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`);
    };
    tick();
    if (!this._progressTimer) this._progressTimer = window.setInterval(tick, 1000);
  }

  _designedState(this: Session, state: string | null): void {
    const prev = this._prevState;
    this._prevState = state;
    if (state === "working" && prev !== "working" && prev !== "waiting") this._turnStartedAt = Date.now();
    if (state === "exited") this._clearCards();
    else if (state === "finished" || state === "error") {
      this._clearCards(true);
      const since = this._turnStartedAt ?? 0;
      this._pending = (this._pending ?? []).filter((el) => {
        if (Number(el.dataset.at ?? 0) < since) { el.remove(); return false; }
        return true;
      });
      this._lastSent = undefined;
    } else if (state === "idle" && prev === "waiting" && !this._selfAnswer) this._clearCards(true);
    if (state === "finished" || state === "error" || state === "exited" || (state === "idle" && prev === "working")) this._sweepStreams();
    this._selfAnswer = false;
    if (this._designedStopEl) this._designedStopEl.disabled = false;
    this._stopping = false;
    this._syncDesigned();
  }

  _currentPick(this: Session): { model?: string; effort?: string } {
    const info = this._modelInfo;
    const alias = info?.model ? MODELS.find(([v]) => info.model === v || info.model.includes(v))?.[0] : undefined;
    return { model: alias, effort: info?.effort };
  }

  _nextPick(this: Session): { model?: string; effort?: string } {
    return { ...this._currentPick(), ...this._modelStage };
  }

  _pickChanges(this: Session): boolean {
    const stage = this._modelStage;
    if (!stage) return false;
    const now = this._currentPick();
    return (stage.model !== undefined && stage.model !== now.model) || (stage.effort !== undefined && stage.effort !== now.effort);
  }

  async _syncModelPill(this: Session, read = false): Promise<void> {
    const pill = this._designedModelEl;
    const el = pill?.querySelector(".agent-manager-designed-model-label");
    if (!pill || !el || this.designedReadOnly()) return;
    if (read && !this._modelInfo) {
      try { this._modelInfo = await this.getSessionModel(); } catch { /* empty */ }
    }
    const next = this._nextPick();
    const info = this._modelInfo;
    const model = next.model && this._modelStage?.model ? (MODELS.find(([v]) => v === next.model)?.[1] ?? next.model)
      : info?.model ? (MODELS.find(([v]) => v === info.model)?.[1] ?? prettyModelName(info.model)) : "Model";
    const effort = EFFORTS.find(([v]) => v === next.effort)?.[1] ?? next.effort;
    el.setText(model);
    pill.querySelector(".agent-manager-designed-model-effort")?.setText(effort ?? "");
    const staged = this._pickChanges();
    pill.toggleClass("is-staged", staged);
    pill.setAttribute("aria-label", staged ? "Model and effort: changes when you send your next message" : "Model and effort");
  }

  _toggleModelPop(this: Session): void {
    if (this._modelPopEl) { this._closeModelPop(); return; }
    const anchor = this._designedModelEl;
    const row = anchor?.closest<HTMLElement>(".agent-manager-designed-status");
    if (!anchor || !row) return;
    const pop = row.createDiv({ cls: "agent-manager-designed-pop" });
    this._modelPopEl = pop;
    const stage = (patch: { model?: string; effort?: string }): void => {
      this._modelStage = { ...this._modelStage, ...patch };
      if (!this._pickChanges()) this._modelStage = undefined;
      void this._syncModelPill();
      this._closeModelPop();
    };
    const pick = this._nextPick();
    for (const [v, label] of MODELS) {
      const it = pop.createEl("button", { cls: "agent-manager-designed-pop-item" });
      it.createSpan({ text: label });
      if (pick.model === v) import_obsidian.setIcon(it.createSpan({ cls: "agent-manager-designed-pop-check" }), "check");
      it.addEventListener("click", () => stage({ model: v }));
    }
    pop.createDiv({ cls: "agent-manager-designed-pop-sep" });
    const eff = pop.createEl("button", { cls: "agent-manager-designed-pop-item agent-manager-designed-pop-effort" });
    eff.createSpan({ text: "Effort" });
    eff.createSpan({ cls: "agent-manager-designed-pop-muted", text: EFFORTS.find(([v]) => v === pick.effort)?.[1] ?? "" });
    import_obsidian.setIcon(eff.createSpan({ cls: "agent-manager-designed-pop-chevron" }), "chevron-right");
    const sub = pop.createDiv({ cls: "agent-manager-designed-pop agent-manager-designed-pop-sub" });
    const fixed = this.plugin.terminal?.agentVariable("CLAUDE_CODE_EFFORT_LEVEL");
    sub.createDiv({ cls: "agent-manager-designed-pop-note", text: fixed ? `Effort is set to ${fixed} by CLAUDE_CODE_EFFORT_LEVEL in the CLIs' environment, which outranks a pick here.` : "Higher effort thinks longer: better on hard work, but slower, and it uses your limits faster." });
    for (const [v, label] of fixed ? [] : EFFORTS) {
      const it = sub.createEl("button", { cls: "agent-manager-designed-pop-item" });
      it.createSpan({ text: label });
      if (v === "max") it.createSpan({ cls: "agent-manager-designed-pop-warn", text: "uses much more" });
      if (pick.effort === v) import_obsidian.setIcon(it.createSpan({ cls: "agent-manager-designed-pop-check" }), "check");
      it.addEventListener("click", () => stage({ effort: v }));
    }
    const showSub = (): void => sub.addClass("is-shown");
    eff.addEventListener("mouseenter", showSub);
    eff.addEventListener("click", showSub);
    for (const it of Array.from(pop.querySelectorAll(":scope > .agent-manager-designed-pop-item"))) {
      if (it !== eff) it.addEventListener("mouseenter", () => sub.removeClass("is-shown"));
    }
    const doc = row.doc;
    const outside = (e: MouseEvent): void => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this._closeModelPop(); };
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); this._closeModelPop(); } };
    window.setTimeout(() => { doc.addEventListener("mousedown", outside, true); doc.addEventListener("keydown", esc, true); }, 0);
    this._modelPopClose = () => { doc.removeEventListener("mousedown", outside, true); doc.removeEventListener("keydown", esc, true); };
  }

  _closeModelPop(this: Session): void {
    this._modelPopClose?.();
    this._modelPopClose = undefined;
    this._modelPopEl?.remove();
    this._modelPopEl = null;
  }

  async _applyPick(this: Session): Promise<string | null> {
    if (!this._pickChanges()) { this._modelStage = undefined; return null; }
    if (this.programState === "working") return "Not sent: Claude is working. A model or effort change waits until it's done.";
    if (!(await this._transcriptFile())) return "Not sent: a model or effort change needs a first message to resume from. Send one without the change first.";
    const next = this._nextPick();
    const stage = this._modelStage ?? {};
    const before = this._attempt;
    const disarm = (why: string): string => { this._restartForPick = false; this._pickOnce = undefined; return why; };
    this._pickOnce = { model: stage.model, effort: stage.effort ?? (stage.model ? this._currentPick().effort : undefined) };
    this._restartForPick = true;
    this._designedSay("Switching model or effort, then sending…", true);
    if (!(await this.submitLine("/exit"))) return disarm("Not sent: the session didn't take the switch. Try again.");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !this._closed && !(this._attempt > before && this.running && this.hasOutput)) await new Promise((r) => window.setTimeout(r, 150));
    if (this._closed) return disarm("");
    if (!(this._attempt > before && this.running)) return disarm("Not sent: the session didn't come back after switching. Show the terminal to see why.");
    await this.waitForQuiet(800, 8000);
    this._modelStage = undefined;
    this._modelInfo = { model: next.model ?? this._modelInfo?.model ?? "", ...(next.effort ? { effort: next.effort } : {}) };
    void this._syncModelPill();
    return null;
  }

  _attachFolder(this: Session): string {
    const own = this.plugin.agentById(this.agentId())?.attachFolder;
    const general = this.plugin.pluginData.attachFolder;
    return (own || (typeof general === "string" ? general : "")).trim();
  }

  _addAttachments(this: Session, files: File[]): void {
    if (!files.length) return;
    if (!this._attachFolder()) { this._designedSay("Set an attachments folder in Settings → Agent Manager → Sessions, or on this profile's page, to add files."); return; }
    (this._attachments ??= []).push(...files.map((file) => ({ file })));
    this._renderChips();
    this._designedBoxEl?.focus();
  }

  _renderChips(this: Session): void {
    const el = this._designedChipsEl;
    if (!el) return;
    for (const u of this._chipUrls?.splice(0) ?? []) URL.revokeObjectURL(u);
    el.empty();
    const list = this._attachments ?? [];
    el.toggleClass("is-shown", list.length > 0);
    list.forEach((a, i) => {
      const chip = el.createDiv({ cls: "agent-manager-designed-chip", attr: { title: a.file.name } });
      if (a.file.type.startsWith("image/")) {
        const url = URL.createObjectURL(a.file);
        (this._chipUrls ??= []).push(url);
        chip.addClass("is-image");
        chip.createEl("img", { attr: { src: url, alt: a.file.name } });
      } else import_obsidian.setIcon(chip.createSpan({ cls: "agent-manager-designed-chip-icon" }), "file");
      chip.createSpan({ cls: "agent-manager-designed-chip-name", text: a.file.name });
      const x = chip.createEl("button", { cls: "agent-manager-designed-chip-x", attr: { "aria-label": `Remove ${a.file.name}` } });
      import_obsidian.setIcon(x, "x");
      x.addEventListener("click", () => { this._attachments?.splice(i, 1); this._renderChips(); });
    });
  }

  async _copyAttachments(this: Session, list: { file: File; path?: string }[]): Promise<string[] | string> {
    if (!list.length) return [];
    const folder = this._attachFolder();
    if (!folder) return "Not sent: set an attachments folder in settings first.";
    const vault = this.app.vault;
    try {
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      for (const a of list) {
        if (a.path) continue;
        const name = a.file.name.replace(/[\\/:]/g, "-") || "file";
        const dot = name.lastIndexOf(".");
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot + 1) : "";
        const at = (n: number) => (0, import_obsidian.normalizePath)(`${folder}/${base}${n ? ` ${n}` : ""}${ext ? `.${ext}` : ""}`);
        let n = 0;
        while (vault.getAbstractFileByPath(at(n)) && n < 1000) n++;
        await vault.createBinary(at(n), await a.file.arrayBuffer());
        a.path = at(n);
      }
    } catch (e) {
      return `Not sent: couldn't copy a file into ${folder} (${e instanceof Error ? e.message : String(e)}).`;
    }
    const cwd = this.workingDir || this.plugin.getVaultPath();
    return list.map((a) => {
      const abs = path.join(this.plugin.getVaultPath(), a.path as string);
      const rel = path.relative(cwd, abs);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
    });
  }

  _syncMention(this: Session): void {
    const box = this._designedBoxEl;
    if (!box) return;
    const upto = box.value.slice(0, box.selectionStart ?? box.value.length);
    const m = /(?:^|\s)@([^\s@"]*)$/.exec(upto);
    if (!m) { this._closeMention(); return; }
    const query = m[1];
    const files = (this._mentionFiles ??= this.app.vault.getFiles());
    const search = query ? import_obsidian.prepareFuzzySearch(query) : null;
    const top: { file: InstanceType<typeof import_obsidian.TFile>; score: number }[] = [];
    for (const file of files) {
      const score = search ? search(file.path)?.score : file.stat.mtime;
      if (score === undefined || (top.length === 8 && score <= top[7].score)) continue;
      top.push({ file, score });
      top.sort((a, b) => b.score - a.score);
      if (top.length > 8) top.pop();
    }
    const hits = top.map((s) => s.file);
    if (!hits.length) { this._closeMention(); return; }
    this._mentionAt = upto.length - query.length - 1;
    this._mentionHits = hits;
    this._mentionIndex = 0;
    this._renderMention();
  }

  _renderMention(this: Session): void {
    const row = this._designedBoxEl?.closest<HTMLElement>(".agent-manager-designed-input");
    if (!row) return;
    let pop = this._mentionEl;
    if (!pop) { pop = row.createDiv({ cls: "agent-manager-designed-pop agent-manager-designed-mention" }); this._mentionEl = pop; }
    pop.empty();
    (this._mentionHits ?? []).forEach((f, i) => {
      const it = pop.createEl("button", { cls: "agent-manager-designed-pop-item" + (i === this._mentionIndex ? " is-selected" : "") });
      import_obsidian.setIcon(it.createSpan({ cls: "agent-manager-designed-mention-icon" }), f.extension === "md" ? "file-text" : "file");
      it.createSpan({ cls: "agent-manager-designed-mention-name", text: f.basename });
      it.createSpan({ cls: "agent-manager-designed-pop-muted", text: f.parent && f.parent.path !== "/" ? f.parent.path : "" });
      it.addEventListener("mousedown", (e) => { e.preventDefault(); this._pickMention(i); });
    });
  }

  _mentionKey(this: Session, e: KeyboardEvent): boolean {
    const hits = this._mentionHits;
    if (!this._mentionEl || !hits?.length || e.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this._mentionIndex = ((this._mentionIndex ?? 0) + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      this._renderMention();
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); this._pickMention(this._mentionIndex ?? 0); return true; }
    if (e.key === "Escape") { e.preventDefault(); this._closeMention(); return true; }
    return false;
  }

  _pickMention(this: Session, i: number): void {
    const box = this._designedBoxEl;
    const file = this._mentionHits?.[i];
    if (!box || !file) return;
    const upto = box.value.slice(0, box.selectionStart ?? box.value.length);
    const tok = /(?:^|\s)@([^\s@"]*)$/.exec(upto);
    if (!tok) { this._closeMention(); return; }
    const at = upto.length - tok[1].length - 1;
    const cwd = this.workingDir || this.plugin.getVaultPath();
    const abs = path.join(this.plugin.getVaultPath(), file.path);
    const rel = path.relative(cwd, abs);
    const p = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
    const ref = /\s/.test(p) ? `@"${p}" ` : `@${p} `;
    const end = box.selectionStart ?? box.value.length;
    box.value = box.value.slice(0, at) + ref + box.value.slice(end);
    const caret = at + ref.length;
    box.setSelectionRange(caret, caret);
    this._closeMention();
    this._fitBox();
    box.focus();
  }

  _insertMentions(this: Session, vaultPaths: string[]): void {
    const box = this._designedBoxEl;
    if (!box || !vaultPaths.length) return;
    if (this._designedSending) { this._designedSay("Wait for the message to go, then add the mention."); return; }
    const cwd = this.workingDir || this.plugin.getVaultPath();
    const refs = vaultPaths.map((vp) => {
      const abs = path.join(this.plugin.getVaultPath(), vp);
      const rel = path.relative(cwd, abs);
      const p = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
      return /\s/.test(p) ? `@"${p}"` : `@${p}`;
    });
    const at = box.selectionStart ?? box.value.length;
    const before = box.value.slice(0, at);
    const text = `${before && !/\s$/.test(before) ? " " : ""}${refs.join(" ")} `;
    box.value = before + text + box.value.slice(box.selectionEnd ?? at);
    box.setSelectionRange(at + text.length, at + text.length);
    this._fitBox();
    box.focus();
  }

  _closeMention(this: Session): void {
    this._mentionEl?.remove();
    this._mentionEl = null;
    this._mentionHits = undefined;
    this._mentionFiles = undefined;
    this._mentionAt = undefined;
  }

  _carryToTerminal(this: Session): void {
    if (this.designedReadOnly()) return;
    const box = this._designedBoxEl;
    // eslint-disable-next-line no-control-regex -- control characters are what it strips
    const text = (box?.value ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\s+$/, "");
    if (!box || !text.trim() || !this.running || this._closed) return;
    const why = this.hasPendingInput() || this.view.inputLooksEmpty() !== true ? "the terminal's prompt isn't clearly empty"
      : this._cards?.size || this.programState === "waiting" || this._dialogShowing() ? "Claude is asking something"
        : this._lineBusy ? "Agent Manager is typing into the session"
          : text.includes("\n") && !this.view.bracketedPaste ? "it has more than one line" : null;
    if (why) { notice({ head: "Unsent text kept in the conversation view", detail: `Not moved to the terminal: ${why}.` }); return; }
    this.view.paste(text);
    box.value = "";
    this._fitBox();
  }

  async _carryFromTerminal(this: Session): Promise<void> {
    if (this.designedReadOnly()) return;
    const box = this._designedBoxEl;
    const d = this._draft;
    if (!box || !this.running || !d.pending()) return;
    if (box.value.trim()) { this._designedSay("Your unsent text in the terminal stayed there: this box already has text.", true); return; }
    if (this.view.canReadInput() && !this._lineBusy && !this._cards?.size && this.programState !== "waiting") {
      if (this.view.inputLooksEmpty() === true) return;
      this._lineBusy = true;
      box.readOnly = true;
      let image = false;
      let got: { text: string; cleared: boolean } | null = null;
      try {
        got = await this.view.editInput((text) => {
          image = holdsImage(text);
          return image || !text.trim() ? "leave" : "clear";
        });
      } finally {
        this._lineBusy = false;
        box.readOnly = false;
      }
      if (!got) { this._designedSay("Your unsent text is still in the terminal: it couldn't be moved.", true); return; }
      if (image) { this._designedSay("Your unsent text is still in the terminal: it holds a picture, which can't be moved.", true); return; }
      if (!got.text.trim()) return;
      box.value = got.text;
      this._fitBox();
      box.focus();
      box.setSelectionRange(got.text.length, got.text.length);
      if (!got.cleared) this._designedSay("Your unsent text is in the box; it may still be in the terminal's prompt too.", true);
      return;
    }
    if (d._unknown || d._moved || !d.text().trim() || this._lineBusy || this._cards?.size || this.programState === "waiting" || this._dialogShowing()) {
      this._designedSay("Your unsent text is still in the terminal: it couldn't be moved exactly.", true);
      return;
    }
    if (this.view.inputLooksEmpty() !== false) return;
    const text = d.text();
    const attempt = this._attempt;
    const keys = this._inputCount;
    box.value = text;
    this._fitBox();
    this._lineBusy = true;
    box.readOnly = true;
    try {
      for (let i = 0; i < 12 && this.view.inputLooksEmpty() !== true; i++) {
        if (this._attempt !== attempt || this._inputCount !== keys) { d._unknown = true; return; }
        this.writeRaw("\x15");
        await new Promise((r) => window.setTimeout(r, 70));
      }
    } finally { this._lineBusy = false; box.readOnly = false; }
    if (this.view.inputLooksEmpty() !== true) {
      d._unknown = true;
      this._designedSay("Your unsent text is in the box; part of it may still be in the terminal's prompt.", true);
      return;
    }
    d.clear();
    this._draftChanged();
    box.focus();
    box.setSelectionRange(text.length, text.length);
  }

  async _designedSend(this: Session): Promise<void> {
    const box = this._designedBoxEl;
    if (!box || this._designedSending) return;
    // eslint-disable-next-line no-control-regex -- control characters are what it strips
    const typed = box.value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\s+$/, "");
    const sending = [...(this._attachments ?? [])];
    const files = sending.length;
    if (!typed.trim() && !files) return;
    let text = files ? `${typed}${typed ? "\n\n" : ""}${"x".repeat(files)}` : typed;
    const why = this._sendBlocked(text);
    if (why) { this._designedSay(why); return; }
    this._designedSay("");
    this._designedSending = true;
    box.readOnly = true;
    let r: Awaited<ReturnType<Session["_typeLine"]>>;
    let before = this._inputCount;
    try {
      const stop = await this._applyPick();
      if (stop) { this._designedSay(stop); return; }
      const paths = await this._copyAttachments(sending);
      if (typeof paths === "string") { this._designedSay(paths); return; }
      if (paths.length) text = `${typed}${typed ? "\n\n" : ""}${paths.length === 1 ? "Attached: " : "Attached:\n"}${paths.join("\n")}`;
      if (this._sendBlocked(text)) { this._designedSay(this._sendBlocked(text) ?? ""); return; }
      before = this._inputCount;
      const started = Date.now();
      r = await this._typeLine(text, undefined, { paste: true, guard: () => !this._cards?.size && this.programState !== "waiting" && !(this._stopAt && this._stopAt >= started) });
    } finally {
      this._designedSending = false;
      box.readOnly = false;
    }
    if (r === "shown" || r === "unshown") {
      this._designedSay("");
      this._closeMention();
      box.value = "";
      this._attachments = (this._attachments ?? []).filter((a) => !sending.includes(a));
      this._renderChips();
      this._fitBox();
      this._lastSent = text;
      this._sentInputCount = before;
      if (typed.trim()) { (this._sentHistory ??= []).push(typed); if (this._sentHistory.length > 50) this._sentHistory.shift(); }
      this._recallAt = undefined;
      if (text.startsWith("/")) { this.closeTranscript(false); return; }
      if (text.startsWith("!")) return;
      this._addPending(text);
      return;
    }
    this._designedSay(
      r === "busy" ? "Not sent: Agent Manager is still typing into this session. Try again in a moment."
        : r === "typed" ? "Not sent: you typed in the terminal while this went in. Check the terminal's prompt."
          : (this._cards?.size || this.programState === "waiting") ? "Not sent: Claude asked something while this went in. Answer it, then clear the terminal's prompt, which may hold your text."
            : "Not sent: the session isn't ready, or a prompt appeared. Show the terminal to see it.",
    );
  }

  _sendBlocked(this: Session, text: string): string | null {
    if (!this.running) return "Not sent: the session isn't running.";
    if (this._approvalHooked !== true) return "Not sent: restart this session to type here.";
    if (this.hasPendingInput()) return "Not sent: there's unsent text in the terminal's prompt. Send or clear it there first.";
    if (this._cards?.size || this.programState === "waiting") return "Not sent: Claude is asking you something. Answer it first.";
    if (this._dialogShowing()) return "Not sent: the terminal is showing a prompt. Show the terminal to answer it.";
    const empty = this.view.inputLooksEmpty();
    if (empty === false) return "Not sent: there's text in the terminal's prompt. Send or clear it there first.";
    if (empty === null && this.programState !== "working") return "Not sent: the terminal is busy or showing a prompt. Try again, or show the terminal.";
    if (text.includes("\n") && !this.view.bracketedPaste) return "Not sent: this session can't take several lines at once. Send it as one line.";
    return null;
  }

  _designedStop(this: Session): void {
    if (this._approvalHooked !== true || this.programState !== "working" || this._cards?.size || this._dialogShowing()) return;
    if (this._stopping) return;
    this._stopping = true;
    this._stopAt = Date.now();
    if (this._designedStopEl) this._designedStopEl.disabled = true;
    this.writeRaw("\x1b");
    const sent = this._sentInputCount === this._inputCount ? this._lastSent : undefined;
    const attempt = this._attempt;
    const keys = this._inputCount;
    window.clearTimeout(this._stopTimer);
    this._stopTimer = window.setTimeout(() => { void this._takeBackInterrupted(sent, attempt, keys); }, 900);
  }

  async _takeBackInterrupted(this: Session, sent: string | undefined, attempt: number, keys: number): Promise<void> {
    this._stopTimer = undefined;
    if (!sent || this._attempt !== attempt || this._inputCount !== keys || this._lineBusy || this.view.inputLooksEmpty() !== false) return;
    const probe = this._echoProbe(sent);
    if (probe && !this._promptShows(probe)) return;
    const box = this._designedBoxEl;
    if (!box || box.value.trim()) { this._designedSay("Stopped. Your message is back in the terminal's prompt.", true); return; }
    this._lineBusy = true;
    box.readOnly = true;
    try {
      for (let i = 0; i < 6 && this.view.inputLooksEmpty() === false; i++) {
        if (this._attempt !== attempt || this._inputCount !== keys) return;
        this.writeRaw("\x15");
        await new Promise((r) => window.setTimeout(r, 80));
      }
    } finally { this._lineBusy = false; box.readOnly = false; }
    if (this.view.inputLooksEmpty() === false) return;
    this._lastSent = undefined;
    this._dropPending(sent);
    if (!box.value.trim()) {
      box.value = sent;
      this._fitBox();
      this._designedSay("Stopped. Your message is back in the box.", true);
    }
  }

  _addPending(this: Session, text: string): void {
    const body = this._transcriptBodyEl;
    if (!body) return;
    const box = body.createDiv({ cls: "agent-manager-transcript-msg agent-manager-transcript-user is-pending" });
    box.dataset.text = text.replace(/\s+/g, " ").trim();
    box.dataset.at = String(Date.now());
    this._renderUserText(box, text);
    (this._pending ??= []).push(box);
    const host = this.transcriptHost;
    if (host) host.scrollTop = host.scrollHeight;
  }

  _settlePending(this: Session, texts: string[]): void {
    const pending = this._pending;
    if (!pending?.length) return;
    for (const t of texts) this._dropPending(t);
    const body = this._transcriptBodyEl;
    if (body) for (const el of pending) body.appendChild(el);
  }

  _dropPending(this: Session, text: string): void {
    const pending = this._pending;
    const key = text.replace(/\s+/g, " ").trim();
    const at = pending?.findIndex((el) => el.dataset.text === key) ?? -1;
    if (pending && at >= 0) pending.splice(at, 1)[0].remove();
  }

  _showCard(this: Session, held: HeldAsk): void {
    const cards = (this._cards ??= new Map());
    const el = createDiv({ cls: "agent-manager-designed-card" });
    cards.set(held.id, { held, el });
    this._renderCard(held, el);
    this._designedCardsEl?.appendChild(el);
    this._syncDesigned();
    this._syncAsking();
    if (held.ask.agentId) this._refreshAgentCards();
    const host = this.transcriptHost;
    if (host && this._transcriptOpen) host.scrollTop = host.scrollHeight;
  }

  _renderCard(this: Session, held: HeldAsk, el: HTMLElement): void {
    const ask = held.ask;
    const kind = cardKind(ask.toolName);
    const who = ask.agentId ? `A sub-agent${ask.agentType ? ` (${ask.agentType})` : ""} asks` : "Claude asks";
    el.createDiv({ cls: "agent-manager-designed-card-who", text: who });
    if (kind === "plan") { this._renderPlan(held, el); return; }
    if (kind === "question") { this._renderQuestion(held, el); return; }
    const s = describeTool(ask);
    el.createDiv({ cls: "agent-manager-designed-card-title", text: s.title });
    if (s.detail) el.createEl("pre", { cls: "agent-manager-designed-card-detail", text: s.detail });
    if (s.extra?.text) {
      el.createDiv({ cls: "agent-manager-designed-card-label", text: s.extra.label });
      el.createEl("pre", { cls: "agent-manager-designed-card-detail", text: s.extra.text });
    }
    const row = el.createDiv({ cls: "agent-manager-designed-card-actions" });
    row.createEl("button", { cls: "mod-cta", text: "Allow" }).addEventListener("click", () => this._answerCard(held, allowBody()));
    row.createEl("button", { text: "Deny" }).addEventListener("click", () => this._answerCard(held, denyBody()));
  }

  _renderPlan(this: Session, held: HeldAsk, el: HTMLElement): void {
    el.addClass("is-plan");
    el.createDiv({ cls: "agent-manager-designed-card-title", text: "Claude's plan" });
    const input = held.ask.toolInput;
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    if (!plan) {
      el.createDiv({ cls: "agent-manager-designed-card-label", text: "The plan didn't come through here. It's in the terminal." });
      el.createDiv({ cls: "agent-manager-designed-card-actions" }).createEl("button", { cls: "mod-cta", text: "Show terminal" }).addEventListener("click", () => this.closeTranscript());
      return;
    }
    const planEl = el.createDiv({ cls: "agent-manager-designed-plan agent-manager-transcript-md markdown-rendered" });
    const paneH = this.transcriptHost?.clientHeight ?? 0;
    if (paneH) planEl.setCssProps({ "--agent-manager-plan-max": `${Math.max(120, Math.round(paneH * 0.45))}px` });
    void this._renderReply(plan, planEl).catch(() => { planEl.setText(plan); });
    const row = el.createDiv({ cls: "agent-manager-designed-card-actions" });
    PLAN_MODES.forEach(([mode, label], i) => {
      row.createEl("button", { cls: i === 0 ? "mod-cta" : "", text: label }).addEventListener("click", () => this._answerCard(held, planAllowBody(input, mode)));
    });
    const fb = el.createEl("textarea", { cls: "agent-manager-designed-plan-feedback", attr: { rows: "2", placeholder: "Anything Claude should change in the plan" } });
    fb.addEventListener("keydown", (e) => e.stopPropagation());
    const back = el.createDiv({ cls: "agent-manager-designed-card-actions" });
    back.createEl("button", { text: "Keep planning" }).addEventListener("click", () => this._answerCard(held, planDenyBody(fb.value)));
    back.createEl("button", { text: "Show terminal" }).addEventListener("click", () => this.closeTranscript());
  }

  _renderQuestion(this: Session, held: HeldAsk, el: HTMLElement): void {
    const qs = questionsOf(held.ask.toolInput);
    const picks: string[][] = qs.map(() => []);
    const submit = createEl("button", { cls: "mod-cta", text: "Answer" });
    const ready = (): void => { submit.disabled = picks.some((p) => !p.length); };
    qs.forEach((q, qi) => {
      const block = el.createDiv({ cls: "agent-manager-designed-question" });
      if (q.header) block.createDiv({ cls: "agent-manager-designed-card-label", text: q.header });
      block.createDiv({ cls: "agent-manager-designed-card-title", text: q.question });
      const opts = block.createDiv({ cls: "agent-manager-designed-options" });
      for (const o of q.options) {
        const b = opts.createEl("button", { cls: "agent-manager-designed-option" });
        b.createDiv({ cls: "agent-manager-designed-option-label", text: o.label });
        if (o.description) b.createDiv({ cls: "agent-manager-designed-option-desc", text: o.description });
        b.addEventListener("click", () => {
          const p = picks[qi];
          if (q.multiSelect) {
            const at = p.indexOf(o.label);
            if (at >= 0) p.splice(at, 1); else p.push(o.label);
          } else {
            p.splice(0, p.length, o.label);
            for (const other of Array.from(opts.children)) other.removeClass("is-picked");
          }
          b.toggleClass("is-picked", p.includes(o.label));
          ready();
        });
      }
      if (q.multiSelect) block.createDiv({ cls: "agent-manager-designed-card-note", text: "Pick any." });
    });
    el.createDiv({ cls: "agent-manager-designed-card-note", text: "To type your own answer, use the terminal." });
    const row = el.createDiv({ cls: "agent-manager-designed-card-actions" });
    row.appendChild(submit);
    submit.addEventListener("click", () => {
      const updated = questionAnswer(held.ask.toolInput, picks);
      if (updated) this._answerCard(held, allowBody(updated));
    });
    row.createEl("button", { text: "Show terminal" }).addEventListener("click", () => this.closeTranscript());
    ready();
  }

  _answerCard(this: Session, held: HeldAsk, body: string): void {
    held.answer(body);
    this._dropCard(held);
    if (!held.ask.agentId) { this._selfAnswer = true; this.view.answeredByHost(); }
  }

  _dropCard(this: Session, held: HeldAsk): void {
    const c = this._cards?.get(held.id);
    if (!c) return;
    c.el.remove();
    this._cards?.delete(held.id);
    this._syncDesigned();
    this._syncAsking();
    if (held.ask.agentId) this._refreshAgentCards();
  }

  _toolFinished(this: Session, done: PermissionAsk): void {
    for (const c of [...(this._cards?.values() ?? [])]) {
      if (doneMatches(c.held.ask, done)) { c.held.answer(""); this._dropCard(c.held); }
    }
  }

  _clearCards(this: Session, mainOnly = false): void {
    for (const c of [...(this._cards?.values() ?? [])]) {
      if (mainOnly && c.held.ask.agentId) continue;
      c.held.answer("");
      this._dropCard(c.held);
    }
  }
}

function hooksBlocked(cwd: string): string | null {
  const blocks = (v: Record<string, unknown>): boolean => {
    if (v.disableAllHooks === true || v.allowManagedHooksOnly === true) return true;
    const urls = v.allowedHttpHookUrls;
    if (Array.isArray(urls) && !urls.some((u) => typeof u === "string" && /127\.0\.0\.1|localhost|^\*$/.test(u))) return true;
    const vars = v.httpHookAllowedEnvVars;
    return Array.isArray(vars) && !vars.includes(TOKEN_VAR);
  };
  for (const key of ["disableAllHooks", "allowManagedHooksOnly", "allowedHttpHookUrls", "httpHookAllowedEnvVars"]) {
    const where = userSetting([], {}, cwd, { vars: [], keys: [key] });
    if (!where || where === "environment" || where === "command") continue;
    try {
      const v = JSON.parse(fs.readFileSync(where, "utf8")) as unknown;
      if (v && typeof v === "object" && blocks(v as Record<string, unknown>)) return where;
    } catch { /* empty */ }
  }
  return null;
}

function timeTip(at: string): string {
  const t = window.moment(at);
  if (!t.isValid()) return "";
  return t.isSame(window.moment(), "day") ? t.format("LT") : t.format("ll, LT");
}

const TOOL_COUNTS = new WeakMap<HTMLElement, Map<string, { n: number; hint: string }>>();

function toolKind(tool: string): string {
  if (tool === "Bash" || tool === "PowerShell" || tool === "exec" || tool === "exec_command" || tool === "shell" || tool === "run_command") return "command";
  if (tool === "Read") return "read";
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "edit";
  if (tool === "Write") return "write";
  if (tool === "Grep" || tool === "Glob") return "search";
  if (tool === "WebFetch") return "fetch";
  if (tool === "WebSearch") return "websearch";
  if (tool === "Agent" || tool === "Task") return "agent";
  return `other:${tool}`;
}

function toolSentence(counts: Map<string, { n: number; hint: string }>): string {
  const name = (h: string): string => h.replace(/^.*[\\/]/, "") || "a file";
  const parts = [...counts.entries()].map(([k, { n, hint }]) => {
    const many = (one: string, several: string) => (n === 1 ? one : `${n} ${several}`);
    if (k === "command") return `ran ${many("a command", "commands")}`;
    if (k === "read") return n === 1 ? `read ${name(hint)}` : `read ${n} files`;
    if (k === "edit") return n === 1 ? `edited ${name(hint)}` : `edited ${n} files`;
    if (k === "write") return n === 1 ? `wrote ${name(hint)}` : `wrote ${n} files`;
    if (k === "search") return `searched${n === 1 ? "" : ` ${n} times`}`;
    if (k === "fetch") return `fetched ${many("a page", "pages")}`;
    if (k === "websearch") return "searched the web";
    if (k === "agent") return `ran ${many("an agent", "agents")}`;
    return `used ${k.slice(6)}${n === 1 ? "" : ` ${n} times`}`;
  });
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { DesignedViewMethods };
